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
 * **Reconciliation is enrichment, never a gate (ADR-040 Amendment A).** Once the
 * terminal event carries a response object, the call is billed and answered:
 * the final object is the authority and nothing the events say can fail it.
 * What the events cannot place or what disagrees with the final object is
 * skipped and reported in the notes.
 *
 * Reconciliation rules (a pure function of the events; no I/O):
 *
 * 1. Items are matched by `id` and occurrence (xAI repeats an id inside one
 *    `output`: live fixtures carry two `message` items with one `msg_` id); an
 *    item with no id is matched to the same type's n-th id-less item on the
 *    other side. When the two sides hold a different number of items under one
 *    id, the occurrences are aligned from the start or from the end, whichever
 *    pairs more items of identical content (a tie goes to the end).
 * 2. The final object is authoritative for an item it carries. A field it lacks
 *    that a completed (`output_item.done`) event carries is filled from the
 *    event; a field both carry with different values keeps the final's value
 *    and, for the item types the adapter consumes, is reported in the notes. An
 *    item the same id carries with a different type keeps the final's item.
 * 3. An item the events completed and the final object lacks is inserted at its
 *    `output_index`, unless an unmatched final item has the same content under
 *    another id (then they are one item).
 * 4. An item that only ever got `output_item.added` plus deltas, and that the
 *    final object lacks, is assembled from the deltas (text, annotations,
 *    summary parts, function arguments, custom tool input) and marked finished;
 *    the notes say so.
 * 5. An event with no integer `output_index` or no typed item cannot be placed
 *    and is skipped; a final `output` that is not an array of objects is
 *    replaced by the items the events built.
 *
 * @module
 */

import type { XaiResponseShape, XaiUsageShape } from './client.js'

/** Why a streamed call failed outside an HTTP error response. */
type XaiStreamFailure =
  | { kind: 'ended_early'; lastEventType: string | undefined }
  | { kind: 'error_event'; code: string | undefined; message: string | undefined }
  | { kind: 'malformed'; detail: string }
  | { kind: 'deadline'; timeoutMs: number }
  | { kind: 'idle'; idleTimeoutMs: number }
  /** The connection failed after output began; `cause` is the transport error. */
  | { kind: 'cut'; detail: string }
  /**
   * The engine's deadline or the caller's signal stopped the call after output
   * began; `cause` is the abort reason.
   */
  | { kind: 'aborted' }
  /**
   * `transport.fetch` answered 200 with a body that is not an event stream.
   * `bodySnippet` is the first 500 characters of that body, secrets redacted.
   */
  | { kind: 'not_event_stream'; contentType: string; bodySnippet?: string }

/**
 * What a stream had delivered when it failed. Output events mean the model was
 * generating (a reasoning call burns tokens before its first visible event), so
 * a retry would repeat that spend and cannot resume it.
 */
interface XaiStreamProgress {
  /** True once any output event or the terminal event arrived. */
  progressed: boolean
  /** Characters of text, reasoning summary, arguments and tool input received. */
  outputChars: number
}

/** What a stream failure carries beside its {@link XaiStreamFailure}. */
interface XaiStreamErrorContext {
  progress?: XaiStreamProgress
  /** The terminal response's usage, exact (ticks included), when one arrived. */
  terminalUsage?: XaiUsageShape
  serviceTier?: string
  cause?: unknown
}

/**
 * A streamed xAI call that failed mid-stream. `classifyXaiError` turns it into a
 * typed `LlmError`. A failure after the terminal event carries the terminal
 * usage (exact); one before it carries only {@link XaiStreamProgress}, from
 * which the adapter derives a lower-bound ESTIMATE: snapshot usage in
 * `response.created` / `response.in_progress` is not used (every live capture
 * had `usage: null`, and a snapshot is by definition a lower bound).
 *
 * @internal
 */
export class XaiStreamError extends Error {
  readonly failure: XaiStreamFailure
  readonly progress: XaiStreamProgress
  readonly terminalUsage: XaiUsageShape | undefined
  readonly servedServiceTier: string | undefined

  constructor(failure: XaiStreamFailure, context: XaiStreamErrorContext = {}) {
    super(describeFailure(failure, context.cause), { cause: context.cause })
    this.name = 'XaiStreamError'
    this.failure = failure
    this.progress = context.progress ?? { progressed: false, outputChars: 0 }
    this.terminalUsage = context.terminalUsage
    this.servedServiceTier = context.serviceTier
  }
}

function describeFailure(failure: XaiStreamFailure, cause: unknown): string {
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
    case 'aborted':
      return `xAI stream was stopped after output began${
        cause instanceof Error ? `: ${cause.message}` : ''
      }`
    case 'idle':
      return `the stream sent no bytes (heartbeats included) for ${failure.idleTimeoutMs} ms`
    case 'cut':
      return `xAI stream was cut after output began: ${
        cause instanceof Error ? cause.message : failure.detail
      }`
    case 'not_event_stream':
      return `xAI transport returned a non-event-stream body (content-type "${failure.contentType}"); transport.fetch must return the text/event-stream response of the request unchanged`
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

/** Two items are one item when only their `id` and `status` differ. */
function sameItemContent(a: PlainRecord, b: PlainRecord): boolean {
  const strip = (item: PlainRecord): PlainRecord => {
    const { id: _id, status: _status, ...rest } = item
    return rest
  }
  return deepEqual(strip(a), strip(b))
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

/** One dispatched SSE frame, as `readSseFrames` yields it. */
export interface XaiSseFrame {
  event: string | undefined
  data: string
}

/** The reduced result of a stream that reached a terminal event. */
interface ReducedXaiStream {
  /** The terminal event's response, with `output` reconciled. */
  response: XaiResponseShape
  /** Diagnostics for what reconciliation did; empty when events and final agree. */
  notes: string[]
  /**
   * True when output events arrived before the terminal event (the terminal
   * event itself does not count). A `response.failed` after output began is
   * not retried: the run already spent tokens.
   */
  outputBegan: boolean
}

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
])

/**
 * The largest event index (`output_index`, `content_index`, `summary_index`,
 * `annotation_index`) the reducer accepts. Real responses have a handful of items
 * and parts; an index beyond this is a broken or hostile upstream, and writing
 * it would make a sparse list millions of entries long.
 */
const MAX_STREAM_INDEX = 10_000

/** A string field of an `error` event: at its top level, else in a nested `error` object. */
function errorField(event: PlainRecord, name: string): string | undefined {
  const nested = isRecord(event['error']) ? event['error'] : undefined
  const value = event[name] ?? nested?.[name]
  return typeof value === 'string' ? value : undefined
}

/** Item types whose content the adapter reads; a divergence in one is reported. */
const CONSUMED_ITEM_TYPES = new Set(['message', 'reasoning', 'function_call'])

/** Response-level events that open a stream without any output in them. */
const OPENING_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.queued',
])

/** Numeric usage a response object carries, if it carries token counts. */
function usageOf(response: PlainRecord | undefined): XaiUsageShape | undefined {
  const usage = response?.['usage']
  if (
    isRecord(usage) &&
    typeof usage['input_tokens'] === 'number' &&
    typeof usage['output_tokens'] === 'number'
  ) {
    return usage as XaiUsageShape
  }
  return undefined
}

/** Characters of model output an item holds: text, summaries, arguments, tool input. */
function itemOutputChars(item: PlainRecord): number {
  let chars = 0
  const text = (value: unknown): void => {
    if (isRecord(value) && typeof value['text'] === 'string')
      chars += value['text'].length
  }
  if (Array.isArray(item['content'])) item['content'].forEach(text)
  if (Array.isArray(item['summary'])) item['summary'].forEach(text)
  if (typeof item['arguments'] === 'string') chars += item['arguments'].length
  if (typeof item['input'] === 'string') chars += item['input'].length
  return chars
}

/**
 * Folds Responses API stream events into one response object.
 *
 * Feed every frame to {@link pushFrame} (or every parsed event to {@link push})
 * until it returns `true`, then call {@link result}. When the stream ends before
 * a terminal event, call {@link endedEarly} for the error to throw.
 */
export class XaiStreamReducer {
  private readonly items = new Map<number, StreamItem>()
  private snapshot: PlainRecord | undefined
  private terminal: { type: string; response: PlainRecord } | undefined
  private lastType: string | undefined
  private progressed = false
  private readonly skipped: string[] = []

  /**
   * Applies one SSE frame. A frame with no `data` (a bare `event: keepalive`) or
   * the `[DONE]` sentinel carries nothing and is skipped. A body that is not JSON
   * is a malformed stream; JSON that is not an event is skipped and reported.
   * Returns `true` once the terminal event has been seen.
   */
  pushFrame(frame: XaiSseFrame): boolean {
    if (frame.data === '' || frame.data === '[DONE]') return false
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch (cause) {
      throw new XaiStreamError(
        {
          kind: 'malformed',
          detail: `an event body is not valid JSON (${
            cause instanceof Error ? cause.message : String(cause)
          })`,
        },
        { ...this.context(), cause },
      )
    }
    if (isRecord(parsed) && typeof parsed['type'] !== 'string') {
      // An `event: error` frame, or a payload that is only an error object, is
      // the stream's error event; anything else typeless is not an event.
      if (frame.event === 'error' || isRecord(parsed['error'])) {
        return this.push({ ...parsed, type: 'error' })
      }
    }
    return this.push(parsed)
  }

  /** Applies one event. Returns `true` once the terminal event has been seen. */
  push(event: unknown): boolean {
    if (!isRecord(event) || typeof event['type'] !== 'string') {
      this.skipped.push('an event that has no string `type`')
      return false
    }
    const type = event['type']
    this.lastType = type
    if (TERMINAL_EVENTS.has(type)) {
      const response = event['response']
      if (!isRecord(response)) {
        throw new XaiStreamError(
          { kind: 'malformed', detail: `${type} carries no response object` },
          this.context(),
        )
      }
      this.terminal = { type, response }
      return true
    }
    if (!OPENING_EVENTS.has(type) && type !== 'error' && type.startsWith('response.')) {
      this.progressed = true
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
            code: errorField(event, 'code'),
            message: errorField(event, 'message'),
          },
          this.context(),
        )
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const rawIndex = event['output_index']
        const index =
          typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
            ? this.index(rawIndex, 'output_index')
            : undefined
        const item = event['item']
        if (index === undefined || !isRecord(item) || typeof item['type'] !== 'string') {
          this.skipped.push(`a ${type} event with no integer output_index or typed item`)
          return false
        }
        this.items.set(index, { item: clone(item), done: type.endsWith('.done') })
        return false
      }
      default:
        this.applyDelta(type, event)
        return false
    }
  }

  /**
   * An event index, or `undefined` when the event has none or it is not a
   * non-negative integer (the event is then skipped, noted). An index above
   * {@link MAX_STREAM_INDEX} is a malformed stream, not a value to write.
   */
  private index(value: unknown, name: string): number | undefined {
    if (typeof value !== 'number') return undefined
    if (!Number.isInteger(value) || value < 0) {
      this.skipped.push(`an event whose ${name} is not a non-negative integer`)
      return undefined
    }
    if (value > MAX_STREAM_INDEX) {
      throw new XaiStreamError(
        {
          kind: 'malformed',
          detail: `${name} ${value} is above the ${MAX_STREAM_INDEX} this client accepts`,
        },
        this.context(),
      )
    }
    return value
  }

  /** The error for a stream that ended without a terminal event. */
  endedEarly(): XaiStreamError {
    return new XaiStreamError(
      { kind: 'ended_early', lastEventType: this.lastType },
      this.context(),
    )
  }

  /** What the stream had delivered so far. */
  progress(): XaiStreamProgress {
    let outputChars = 0
    for (const entry of this.items.values()) outputChars += itemOutputChars(entry.item)
    return { progressed: this.progressed || this.terminal !== undefined, outputChars }
  }

  /** The progress, the terminal usage when one arrived, and the tier, for a failure. */
  context(): Omit<XaiStreamErrorContext, 'cause'> {
    const terminalUsage = usageOf(this.terminal?.response)
    const tier = (this.terminal?.response ?? this.snapshot)?.['service_tier']
    return {
      progress: this.progress(),
      ...(terminalUsage !== undefined ? { terminalUsage } : {}),
      ...(typeof tier === 'string' && tier.length > 0 ? { serviceTier: tier } : {}),
    }
  }

  /**
   * The terminal response with its output reconciled against the events. Never
   * fails once a terminal event with a response arrived.
   *
   * @throws XaiStreamError only when the stream has no terminal event yet.
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
        outputBegan: this.progressed,
      }
    }
    // Likewise `response.incomplete` is an incomplete response whatever its object says.
    const status =
      terminal.type === 'response.incomplete' ? 'incomplete' : response['status']
    const { output, notes } = this.reconcile(response['output'], status)
    return {
      response: { ...response, status, output } as unknown as XaiResponseShape,
      notes: [...this.skippedNotes(), ...notes],
      outputBegan: this.progressed,
    }
  }

  private skippedNotes(): string[] {
    if (this.skipped.length === 0) return []
    const counts = new Map<string, number>()
    for (const what of this.skipped) counts.set(what, (counts.get(what) ?? 0) + 1)
    return [...counts].map(
      ([what, n]) =>
        `xai: skipped ${n} stream event(s) that could not be used (${what}); the final response was used for them.`,
    )
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
    const contentIndex = this.index(event['content_index'], 'content_index')
    const summaryIndex = this.index(event['summary_index'], 'summary_index')
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
    const append = (target: PlainRecord, key: string, delta: unknown): void => {
      if (typeof delta !== 'string') return
      target[key] = `${typeof target[key] === 'string' ? target[key] : ''}${delta}`
    }
    switch (type) {
      case 'response.content_part.added':
      case 'response.content_part.done':
        if (typeof contentIndex === 'number' && isRecord(event['part'])) {
          content()[contentIndex] = clone(event['part'])
        }
        return
      case 'response.output_text.delta':
        append(
          textAt(content(), contentIndex, { type: 'output_text', text: '' }),
          'text',
          event['delta'],
        )
        return
      case 'response.output_text.done': {
        const part = textAt(content(), contentIndex, { type: 'output_text', text: '' })
        if (typeof event['text'] === 'string') part['text'] = event['text']
        return
      }
      case 'response.output_text.annotation.added': {
        const part = textAt(content(), contentIndex, { type: 'output_text', text: '' })
        if (!Array.isArray(part['annotations'])) part['annotations'] = []
        const index = this.index(event['annotation_index'], 'annotation_index')
        if (index !== undefined && event['annotation'] !== undefined) {
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
      case 'response.reasoning_summary_text.delta':
        append(
          textAt(summary(), summaryIndex, { type: 'summary_text', text: '' }),
          'text',
          event['delta'],
        )
        return
      case 'response.reasoning_summary_text.done': {
        const part = textAt(summary(), summaryIndex, { type: 'summary_text', text: '' })
        if (typeof event['text'] === 'string') part['text'] = event['text']
        return
      }
      case 'response.function_call_arguments.delta':
        append(item, 'arguments', event['delta'])
        return
      case 'response.function_call_arguments.done':
        if (typeof event['arguments'] === 'string') item['arguments'] = event['arguments']
        return
      // xAI streams the input of a server tool call (x_search) as a custom tool call.
      case 'response.custom_tool_call_input.delta':
        append(item, 'input', event['delta'])
        return
      case 'response.custom_tool_call_input.done':
        if (typeof event['input'] === 'string') item['input'] = event['input']
        return
      default:
        // `response.web_search_call.*`, heartbeats and event types this
        // version does not know carry nothing the item events do not.
        return
    }
  }

  /** The items the events built, in output order, finished for a response that ended. */
  private eventItems(responseStatus: unknown): PlainRecord[] {
    return [...this.items.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => {
        const item = clone(entry.item)
        if (!entry.done) item['status'] = finishedStatus(responseStatus)
        return item
      })
  }

  private reconcile(
    finalOutput: unknown,
    responseStatus: unknown,
  ): { output: unknown[]; notes: string[] } {
    if (finalOutput !== undefined && !Array.isArray(finalOutput)) {
      return {
        output: this.eventItems(responseStatus),
        notes: [
          'xai: the final response `output` is not an array; the output items were built from the stream events.',
        ],
      }
    }
    const finalItems: PlainRecord[] = []
    let dropped = 0
    for (const item of finalOutput ?? []) {
      if (isRecord(item)) finalItems.push(clone(item))
      else dropped++
    }
    const notes: string[] = []
    if (dropped > 0) {
      notes.push(
        `xai: dropped ${dropped} non-object item(s) from the final response \`output\`.`,
      )
    }

    // Real xAI responses repeat an id within one `output` (two `message` items
    // sharing one `msg_` id, two `reasoning` items sharing one `rs_` id), so an
    // id alone is not a key. Items are grouped by id (or by type when they have
    // none) and the groups are aligned from the END: the final object omits
    // earlier items of a group, never later ones.
    const groupOf = (item: PlainRecord): string => {
      const id = item['id']
      return typeof id === 'string' && id.length > 0
        ? `id:${id}`
        : `anon:${String(item['type'])}`
    }
    const labelOf = (item: PlainRecord): string =>
      typeof item['id'] === 'string' && item['id'].length > 0
        ? `${String(item['type'])} ${item['id']}`
        : String(item['type'])

    const finalGroups = new Map<string, PlainRecord[]>()
    for (const item of finalItems) {
      const group = groupOf(item)
      finalGroups.set(group, [...(finalGroups.get(group) ?? []), item])
    }
    const eventGroups = new Map<string, Array<[number, StreamItem]>>()
    for (const entry of [...this.items.entries()].sort(([a], [b]) => a - b)) {
      const group = groupOf(entry[1].item)
      eventGroups.set(group, [...(eventGroups.get(group) ?? []), entry])
    }

    const bound = new Set<PlainRecord>()
    const unbound: Array<[number, StreamItem]> = []
    for (const [group, entries] of eventGroups) {
      const finals = finalGroups.get(group) ?? []
      // The final object omits items from either end of a group, so the group
      // is aligned from the start or from the end, whichever pairs more items
      // of identical content (a tie goes to the end: the final object omits
      // earlier items, never later ones, in every capture).
      const endOffset = finals.length - entries.length
      const matches = (offset: number): number =>
        entries.filter(([, streamed], i) => {
          const finalItem = finals[i + offset]
          return finalItem !== undefined && sameItemContent(finalItem, streamed.item)
        }).length
      const offset = matches(0) > matches(endOffset) ? 0 : endOffset
      entries.forEach((entry, i) => {
        const finalItem = finals[i + offset]
        if (finalItem === undefined) {
          unbound.push(entry)
          return
        }
        bound.add(finalItem)
        const [, streamed] = entry
        if (finalItem['type'] !== streamed.item['type']) {
          notes.push(
            `xai: output item ${labelOf(finalItem)} is a "${String(streamed.item['type'])}" in the stream and a "${String(finalItem['type'])}" in the final response; the final response is used.`,
          )
          return
        }
        if (!streamed.done) return
        const filled: string[] = []
        const diverged: string[] = []
        for (const [field, value] of Object.entries(streamed.item)) {
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
        // Server tool items (a search call) are replayed verbatim from the final
        // object and the adapter reads nothing in them; xAI's final object also
        // reports a search call's `action.sources` cumulatively for the whole
        // run (live, 2026-10-03), so a difference there is not news.
        if (diverged.length > 0 && CONSUMED_ITEM_TYPES.has(String(finalItem['type']))) {
          notes.push(
            `xai: output item ${labelOf(finalItem)} differs between the stream and the final response in field(s) [${diverged.join(', ')}]; the final response is used.`,
          )
        }
      })
    }

    // An item the final object lacks under its id may still be there under
    // another one: the same content is one item, not a second.
    const spare = finalItems.filter((item) => !bound.has(item))
    const insertions: Array<{ index: number; item: PlainRecord }> = []
    const rebuilt: string[] = []
    const assembled: string[] = []
    for (const [index, entry] of unbound.sort(([a], [b]) => a - b)) {
      const twin = spare.findIndex((item) => sameItemContent(item, entry.item))
      if (twin !== -1) {
        spare.splice(twin, 1)
        continue
      }
      const item = clone(entry.item)
      if (!entry.done) {
        // Never finished by an `output_item.done` and absent from the final
        // object: what the deltas built is all there is. The response ended, so
        // the item is finished too (a replayed `in_progress` item is not valid).
        item['status'] = finishedStatus(responseStatus)
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

function finishedStatus(responseStatus: unknown): string {
  return responseStatus === 'incomplete' ? 'incomplete' : 'completed'
}
