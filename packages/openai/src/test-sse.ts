/**
 * Test helpers: Responses API streams for a stubbed `fetch`.
 *
 * DOCUMENTATION-DERIVED, NOT A CAPTURE (ADR-013). No OpenAI call was made for
 * this package. Every event shape here is built from the streaming event typings
 * of the installed `openai` 7.60.0 SDK (`src/resources/responses/responses.ts`:
 * `ResponseCreatedEvent`, `ResponseOutputItemAddedEvent`,
 * `ResponseContentPartAddedEvent`, `ResponseTextDeltaEvent`,
 * `ResponseTextDoneEvent`, `ResponseFunctionCallArgumentsDeltaEvent`,
 * `ResponseOutputItemDoneEvent`, `ResponseCompletedEvent`,
 * `ResponseIncompleteEvent`, `ResponseFailedEvent`, `ResponseErrorEvent`). The
 * API reference lists the streaming events at
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 * (read 2026-11-20); the field-level shapes come from the SDK typings. Usage
 * figures and ids are synthetic; a test built on these helpers proves what the
 * adapter does with the documented shape, never how OpenAI behaves.
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

/**
 * A 200 stream that sends `events` and then stays open until `signal` aborts
 * (as a real `fetch` body does), for deadline and abort tests.
 */
export function hangingSseResponse(
  events: readonly SseEvent[],
  signal: AbortSignal | null | undefined,
): Response {
  const bytes = new TextEncoder().encode(sseBody(events))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      const fail = (): void => {
        controller.error(
          Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
        )
      }
      if (signal?.aborted === true) fail()
      else signal?.addEventListener('abort', fail, { once: true })
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A JSON error response as the API sends one (`{ error: { message, type, param, code } }`). */
export function errorResponse(
  status: number,
  error: { message: string; type?: string; param?: string | null; code?: string | null },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Synthetic usage in the SDK's `ResponseUsage` shape. */
export function usage(
  input: number,
  output: number,
  extra: {
    cached?: number
    writes?: number
    ttl?: { ttl_30m_tokens: number; ttl_12h_tokens: number }
    reasoning?: number
  } = {},
): Plain {
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: extra.cached ?? 0,
      cache_write_tokens: extra.writes ?? 0,
      ...(extra.ttl !== undefined ? { cache_write_tokens_details: extra.ttl } : {}),
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: extra.reasoning ?? 0 },
    total_tokens: input + output,
  }
}

/** An assistant `message` output item (SDK `ResponseOutputMessage`). */
export function messageItem(id: string, text: string): Plain {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

/** A `reasoning` output item with an encrypted blob (SDK `ResponseReasoningItem`). */
export function reasoningItem(id: string, encrypted: string): Plain {
  return { type: 'reasoning', id, summary: [], encrypted_content: encrypted }
}

/** A `function_call` output item (SDK `ResponseFunctionToolCall`). */
export function functionCallItem(
  id: string,
  callId: string,
  name: string,
  args: string,
): Plain {
  return {
    type: 'function_call',
    id,
    call_id: callId,
    name,
    arguments: args,
    status: 'completed',
  }
}

/** A terminal Responses object (SDK `Response`), the fields the adapter reads plus the required ones. */
export function responseObject(
  output: Plain[],
  options: {
    id?: string
    model?: string
    status?: string
    usage?: Plain | null
    serviceTier?: string | null
    incompleteReason?: string
    error?: { code: string; message: string }
  } = {},
): Plain {
  const response: Plain = {
    id: options.id ?? 'resp_doc_1',
    object: 'response',
    created_at: 1_763_596_800,
    model: options.model ?? 'gpt-6.2-sol',
    status: options.status ?? 'completed',
    output,
    error: options.error ?? null,
    incomplete_details:
      options.incompleteReason !== undefined
        ? { reason: options.incompleteReason }
        : null,
    usage: options.usage === undefined ? usage(10, 5) : options.usage,
  }
  if (options.serviceTier !== null)
    response['service_tier'] = options.serviceTier ?? 'default'
  return response
}

interface StreamOptions {
  /** Terminal event type (default `response.completed`). */
  terminal?: 'response.completed' | 'response.incomplete' | 'response.failed'
  /** Omit the terminal event, as a stream that ends early does. */
  omitTerminal?: boolean
  /** Stop after this many events (the rest are never sent). */
  cutAfter?: number
}

/**
 * The events a streamed call carries for `response`: `response.created` and
 * `response.in_progress` snapshots, then for each output item its `added`
 * skeleton, the deltas that build it and its `done` item, then the terminal event.
 */
export function streamEvents(response: Plain, options: StreamOptions = {}): SseEvent[] {
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
    const skeleton: Plain = { ...item, status: 'in_progress' }
    if (item['type'] === 'message') skeleton['content'] = []
    if (item['type'] === 'function_call') skeleton['arguments'] = ''
    push('response.output_item.added', { ...at, item: skeleton })
    if (item['type'] === 'message') {
      const content = Array.isArray(item['content']) ? (item['content'] as Plain[]) : []
      content.forEach((part, contentIndex) => {
        const where = { ...at, item_id: item['id'], content_index: contentIndex }
        if (part['type'] === 'refusal') {
          push('response.content_part.added', {
            ...where,
            part: { ...part, refusal: '' },
          })
          push('response.refusal.delta', { ...where, delta: part['refusal'] })
          push('response.refusal.done', { ...where, refusal: part['refusal'] })
        } else {
          const text = typeof part['text'] === 'string' ? part['text'] : ''
          push('response.content_part.added', {
            ...where,
            part: { ...part, text: '', annotations: [] },
          })
          push('response.output_text.delta', { ...where, delta: text, logprobs: [] })
          push('response.output_text.done', { ...where, text, logprobs: [] })
        }
        push('response.content_part.done', { ...where, part })
      })
    } else if (item['type'] === 'function_call') {
      const args = typeof item['arguments'] === 'string' ? item['arguments'] : ''
      const where = { ...at, item_id: item['id'] }
      push('response.function_call_arguments.delta', { ...where, delta: args })
      push('response.function_call_arguments.done', {
        ...where,
        name: item['name'],
        arguments: args,
      })
    }
    push('response.output_item.done', { ...at, item })
  })
  if (options.omitTerminal !== true) {
    push(options.terminal ?? 'response.completed', { response })
  }
  return options.cutAfter !== undefined ? events.slice(0, options.cutAfter) : events
}

/** Recorded calls of a stubbed `fetch`. */
export interface FetchCall {
  url: string
  method: string
  headers: Headers
  body: Plain | undefined
  signal: AbortSignal | null | undefined
  /** The `redirect` mode the request asked for (a stub never follows one itself). */
  redirect: RequestInit['redirect']
  /** The request body exactly as sent. */
  rawBody: string | undefined
}

/**
 * A stubbed `fetch` that answers each call with the next responder and records
 * the request (URL, headers, parsed JSON body).
 */
export function stubFetch(
  ...responders: Array<(call: FetchCall) => Response | Promise<Response>>
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const stub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rawBody = init?.body
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as Plain) : undefined,
      signal: init?.signal,
      redirect: init?.redirect,
      rawBody: typeof rawBody === 'string' ? rawBody : undefined,
    }
    calls.push(call)
    const responder = responders[Math.min(calls.length - 1, responders.length - 1)]
    if (responder === undefined) throw new Error('stubFetch: no responder')
    return responder(call)
  }
  return { fetch: stub, calls }
}
