/**
 * Structural `OpenAiClientLike` interface + `buildOpenAiClient` factory.
 *
 * The adapter depends only on the structural interface below. The `openai`
 * package is imported ONLY in {@link buildOpenAiClient}, and only its
 * environment-free `openai/streaming` and `openai/error` modules: no SDK client
 * is ever constructed (ADR-019, ADR-047), so a test or a runtime smoke can also
 * inject a structural client without the SDK. This is the only file in
 * `packages/openai/src` that imports `openai`.
 *
 * Written against the installed `openai` 7.60.0 (`src/client.ts` for the
 * request path it reproduces, `src/core/streaming.ts`, `src/core/error.ts`,
 * `src/internal/errors.ts`, `src/resources/responses/responses.ts`), read
 * 2026-11-20.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { AuthMaterial } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Auth narrowing: OpenAI only accepts an API key
// ---------------------------------------------------------------------------

/**
 * Narrows {@link AuthMaterial} to its `apiKey` string (ADR-019), rejecting the
 * dev-only `CliSessionAuth` variant and an empty key, before the SDK is built.
 */
export function requireApiKey(auth: AuthMaterial): string {
  if (
    !('apiKey' in auth) ||
    typeof auth.apiKey !== 'string' ||
    auth.apiKey.trim() === ''
  ) {
    throw new LlmError('@gullabs/openai requires auth.apiKey', {
      kind: 'invalid_auth',
      retryable: false,
      provider: 'openai',
    })
  }
  return auth.apiKey
}

// ---------------------------------------------------------------------------
// Request shape: what the adapter sends to the Responses API
// ---------------------------------------------------------------------------

/** A text content item of an input message. */
export interface OpenAiInputTextPart {
  type: 'input_text'
  text: string
}

/**
 * An image content item of an input message: a fully qualified `http(s)` URL or
 * a base64 data URL. `detail` is always `'auto'`, the documented default
 * (SDK typing `ResponseInputImage.detail`: "Defaults to `auto`").
 */
export interface OpenAiInputImagePart {
  type: 'input_image'
  image_url: string
  detail: 'auto'
}

/** Content parts this release sends. */
export type OpenAiInputContentPart = OpenAiInputTextPart | OpenAiInputImagePart

/** A user message, or the leading developer message that carries `system`. */
export interface OpenAiInputMessage {
  type: 'message'
  role: 'user' | 'developer'
  content: OpenAiInputContentPart[]
}

/**
 * A prior assistant answer sent as history (the SDK's `EasyInputMessage`, whose
 * content "Can also contain previous assistant responses").
 */
export interface OpenAiAssistantInputMessage {
  type: 'message'
  role: 'assistant'
  content: string
}

/** A function call replayed as input. */
export interface OpenAiFunctionCallInputItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

/** The result of a function call, sent back by the host. */
export interface OpenAiFunctionCallOutputInputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** Every item the adapter puts in `input`, replayed provider output included. */
export type OpenAiRequestInputItem =
  | OpenAiInputMessage
  | OpenAiAssistantInputMessage
  | OpenAiFunctionCallInputItem
  | OpenAiFunctionCallOutputInputItem
  | OpenAiOutputItem

/**
 * Full wire history for stateless continuation (`continuation: 'state'`,
 * ADR-029), scoped under the provider key and bound to the requested model.
 */
export interface OpenAiReplayState {
  openai: { model: string; input: OpenAiRequestInputItem[] }
}

/** Strict structured output (`text.format`). */
export interface OpenAiTextFormat {
  type: 'json_schema'
  name: string
  schema: unknown
  strict: true
}

/** A client-side function tool, always strict. */
export interface OpenAiFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: unknown
  strict: true
}

/** Parameters the adapter sends; the transport adds `stream: true`. */
export interface OpenAiResponseCreateParams {
  model: string
  input: OpenAiRequestInputItem[]
  /** Always `false`: this library never relies on provider-side storage. */
  store: false
  reasoning?: { effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  text?: { format: OpenAiTextFormat }
  max_output_tokens?: number
  service_tier?: 'flex' | 'fast'
  tools?: OpenAiFunctionTool[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
}

// ---------------------------------------------------------------------------
// Response shape: the parts of the Responses object the adapter reads
// ---------------------------------------------------------------------------

/** An output item. Kept open: the adapter reads `message`, `reasoning` and `function_call`. */
export interface OpenAiOutputItem {
  type: string
  [key: string]: unknown
}

/** `Response.usage` (SDK `ResponseUsage`), every field treated as possibly absent at runtime. */
export interface OpenAiUsageShape {
  input_tokens: number
  input_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
    cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number }
  }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
  [otherKeys: string]: unknown
}

/** The Responses object, as far as the adapter reads it. */
export interface OpenAiResponseShape {
  id: string
  model: string
  /** `completed`, `incomplete` or `failed` on a terminal event; kept a string. */
  status: string
  incomplete_details?: { reason?: string } | null
  error?: { code?: string; message?: string } | null
  output: OpenAiOutputItem[]
  usage?: OpenAiUsageShape | null
  /** The tier the response says served it, verbatim; absent when not echoed. */
  service_tier?: string | null
}

/** What the call reported outside the response body. */
export interface OpenAiResponseMeta {
  /** The `x-request-id` response header. Absent when none was sent. */
  requestId?: string
  /** True when output arrived before the response ended (an output event, or output listed in the terminal snapshot). */
  streamProgressed?: boolean
  /** What reconciling the terminal response with the completed stream items did; one warning each. */
  streamNotes?: string[]
}

/** Per-request options the adapter passes to `responses.create`. */
export interface OpenAiRequestOptions {
  signal?: AbortSignal
  /** The whole-call deadline in milliseconds (see {@link buildOpenAiClient}). */
  timeout?: number
  /** Called with the {@link OpenAiResponseMeta} before `create` resolves. */
  onResponse?: (meta: OpenAiResponseMeta) => void
}

/**
 * Structural interface the adapter uses. `create` resolves to the terminal
 * response object. Satisfied by {@link buildOpenAiClient}'s client and by any
 * structural client a host or test injects through `openaiAdapter({ client })`.
 */
export interface OpenAiClientLike {
  responses: {
    create(
      params: OpenAiResponseCreateParams,
      options?: OpenAiRequestOptions,
    ): Promise<OpenAiResponseShape>
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only destination: explicit, so `OPENAI_BASE_URL` cannot move a call. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/**
 * Deadline for a request with no `timeoutMs`: one hour. Reasoning calls at
 * high effort can run many minutes; the SDK default (10 minutes) would cut them.
 */
export const OPENAI_DEFAULT_TIMEOUT_MS = 3_600_000

/**
 * Added to `timeoutMs` for the client deadline, so the engine's own deadline
 * (armed at exactly `timeoutMs`) fires first and the caller sees its clean
 * timeout rather than the client's.
 */
export const OPENAI_TIMEOUT_BUFFER_MS = 5_000

/**
 * Largest `timeoutMs` the config schemas accept: Node timers fire after 1 ms
 * above 2^31 - 1, and the client deadline is `timeoutMs` plus the buffer.
 */
export const OPENAI_MAX_TIMEOUT_MS = 2_147_483_647 - OPENAI_TIMEOUT_BUFFER_MS

// ---------------------------------------------------------------------------
// Stream failures
// ---------------------------------------------------------------------------

/** How a streamed call ended without a usable terminal event. */
export type OpenAiStreamFailure =
  | { kind: 'ended_early' }
  | { kind: 'deadline'; timeoutMs: number }
  | { kind: 'aborted' }
  | { kind: 'cut'; detail: string }
  | { kind: 'error_event'; code?: string; message?: string }

/** What the stream had delivered when it failed. */
export interface OpenAiStreamProgress {
  /** True once an output event arrived (any event outside the lifecycle events and `error`). */
  progressed: boolean
  /** Characters received in `*.delta` events. */
  outputChars: number
}

/**
 * A streamed call that did not reach a terminal event. The adapter classifies
 * it (ADR-040 rules: retryable only while nothing was generated).
 *
 * @internal
 */
export class OpenAiStreamError extends Error {
  readonly failure: OpenAiStreamFailure
  readonly progress: OpenAiStreamProgress

  constructor(
    failure: OpenAiStreamFailure,
    progress: OpenAiStreamProgress,
    options?: { cause?: unknown },
  ) {
    super(describeFailure(failure))
    this.name = 'OpenAiStreamError'
    this.failure = failure
    this.progress = { ...progress }
    if (options !== undefined && 'cause' in options) this.cause = options.cause
  }
}

function describeFailure(failure: OpenAiStreamFailure): string {
  switch (failure.kind) {
    case 'ended_early':
      return 'OpenAI stream ended without a terminal event (response.completed, response.incomplete or response.failed)'
    case 'deadline':
      return `OpenAI stream was still open after the ${failure.timeoutMs} ms client deadline`
    case 'aborted':
      return 'OpenAI stream was aborted after output began'
    case 'cut':
      return `OpenAI stream failed after output began: ${failure.detail}`
    case 'error_event':
      return `OpenAI stream sent an error event${
        failure.code !== undefined ? ` (code "${failure.code}")` : ''
      }${failure.message !== undefined ? `: ${failure.message}` : ''}`
  }
}

/**
 * The stream events that are NOT output: the six lifecycle events and `error`.
 * In the `openai` 7.60.0 typings (`ResponseStreamEvent`) every other event
 * reports model output (an output item, a content part, a text, refusal,
 * reasoning, function-argument or audio delta or done, an annotation, a tool
 * call's progress); all of them except the audio events carry `output_index`.
 * Output has begun once any event outside this set arrives. A terminal event or
 * an `error` event is not output, so a failure that arrives before any output
 * event keeps the "before output" rule (ADR-040).
 */
const NON_OUTPUT_EVENTS: ReadonlySet<string> = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.incomplete',
  'response.failed',
  'error',
])

const TERMINAL_STATUS: Readonly<Record<string, string>> = {
  'response.completed': 'completed',
  'response.incomplete': 'incomplete',
  'response.failed': 'failed',
}

// ---------------------------------------------------------------------------
// buildOpenAiClient: an isolated transport over the SDK's environment-free parts
// ---------------------------------------------------------------------------

/**
 * Build the real client from {@link AuthMaterial}.
 *
 * **No SDK client is constructed.** The `openai` 7.60.0 `OpenAI` constructor is
 * inherently ambient (`src/client.ts`): it reads `OPENAI_BASE_URL`,
 * `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`,
 * `OPENAI_WEBHOOK_SECRET`, `OPENAI_LOG` and `OPENAI_CUSTOM_HEADERS` through
 * `readEnv`, and no option turns the custom-header read off (a malformed value
 * throws inside the constructor). Under ADR-019 the client therefore sends the
 * request itself and uses only two SDK modules, both environment-free:
 *
 * - `openai/error` (`src/core/error.ts`): `APIError.generate` turns a non-2xx
 *   response into the SDK's own status error, and `APIConnectionError` /
 *   `APIConnectionTimeoutError` wrap a `fetch` rejection, exactly as the SDK's
 *   request path (`makeRequest`, `makeStatusError`) builds them, so core's
 *   `classifyError`, the `Retry-After` reading and the billing-code checks see
 *   the same objects as before.
 * - `openai/streaming` (`src/core/streaming.ts`): `Stream.fromSSEResponse`
 *   decodes the event stream and turns an `error` event into an `APIError` with
 *   no status.
 *
 * Their runtime module graph (`streaming.js`, `core/streaming.js`,
 * `core/error.js`, `error.js`, `internal/{tslib,errors,shims}.js`,
 * `internal/decoders/line.js`, `internal/utils/{bytes,log,values}.js`) reads no
 * environment variable and does not load the client module (its reference to
 * `OpenAI` is type-only); checked in the installed 7.60.0 on 2026-11-20. One
 * side effect remains: `Stream.fromSSEResponse` without a client logs two fixed
 * lines (no payload) through `console.error` when an event is not valid JSON,
 * just before it throws.
 *
 * The request: `POST https://api.openai.com/v1/responses` through the injected
 * or global `fetch`, with exactly `authorization: Bearer <key>`,
 * `content-type: application/json` and `accept: text/event-stream`, the body
 * `JSON.stringify({ ...params, stream: true })`, and the call's own abort
 * signal. No `user-agent` is set: the runtime's `fetch` supplies its default,
 * and a package version string would have to be injected at build time for a
 * value the API does not need. One HTTP request per attempt, by construction
 * (there is no retry loop here; retries are the engine's).
 *
 * A terminal event (`response.completed`, `response.incomplete` or
 * `response.failed`) is required: a stream that ends without one is an
 * {@link OpenAiStreamError} (`ended_early`). `timeout` arms one timer from the
 * start of the call that covers the wait for headers and the whole body (the
 * SDK's own `timeout` only bounded the wait for headers on a stream). The
 * caller's signal is forwarded, its reason kept.
 *
 * Reconciling the terminal response with completed items: see
 * {@link reconcileWithCompletedItems}.
 *
 * @param auth - `{ apiKey }`.
 * @param fetchImpl - Test seam: the `fetch` to use (defaults to the global
 *   `fetch`). Not exported from the package index.
 */
export async function buildOpenAiClient(
  auth: AuthMaterial,
  fetchImpl?: typeof fetch,
): Promise<OpenAiClientLike> {
  const apiKey = requireApiKey(auth)
  const [{ Stream }, errors] = await Promise.all([
    import('openai/streaming'),
    import('openai/error'),
  ])

  /** An `error` event: the stream decoder throws an `APIError` with no HTTP status for it. */
  const isErrorEvent = (err: unknown): err is InstanceType<typeof errors.APIError> =>
    err instanceof errors.APIError &&
    err.status === undefined &&
    !(err instanceof errors.APIConnectionError) &&
    !(err instanceof errors.APIUserAbortError)

  /** The SDK's mapping of a `fetch` rejection (`makeRequest`, 7.60.0). */
  const connectionError = (raw: unknown): Error => {
    const error = raw instanceof Error ? raw : new Error(String(raw))
    const cause: unknown = (error as { cause?: unknown }).cause
    const isTimeout =
      error.name === 'AbortError' ||
      /timed? ?out/i.test(
        String(error) +
          (cause instanceof Error
            ? String(cause)
            : typeof cause === 'string'
              ? cause
              : ''),
      )
    if (isTimeout) {
      const code =
        typeof cause === 'object' && cause !== null
          ? (cause as { code?: unknown }).code
          : undefined
      const timeoutError = new errors.APIConnectionTimeoutError(
        code === 'UND_ERR_HEADERS_TIMEOUT'
          ? {
              message:
                'Request timed out. Node.js fetch timed out waiting for response headers.',
            }
          : {},
      )
      return Object.assign(timeoutError, { cause: error })
    }
    return new errors.APIConnectionError({ cause: error })
  }

  /** The SDK's mapping of a non-2xx response (`makeRequest` and `makeStatusError`, 7.60.0). */
  const statusError = async (response: Response): Promise<Error> => {
    const text = await response
      .text()
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    const message = json !== undefined ? undefined : text
    const normalized =
      json !== null &&
      typeof json === 'object' &&
      ((json as { error?: unknown }).error === null ||
        (json as { error?: unknown }).error === undefined)
        ? { error: json }
        : json
    return errors.APIError.generate(
      response.status,
      normalized as object | undefined,
      message,
      response.headers,
    )
  }

  const send = fetchImpl ?? ((input, init) => fetch(input, init))

  return {
    responses: {
      async create(
        params: OpenAiResponseCreateParams,
        options?: OpenAiRequestOptions,
      ): Promise<OpenAiResponseShape> {
        const { signal, timeout, onResponse } = options ?? {}
        const controller = new AbortController()
        const forwardAbort = (): void => {
          controller.abort(signal?.reason)
        }
        if (signal?.aborted === true) forwardAbort()
        else signal?.addEventListener('abort', forwardAbort, { once: true })
        let deadlineHit = false
        const deadlineTimer =
          timeout !== undefined
            ? setTimeout(() => {
                deadlineHit = true
                controller.abort()
              }, timeout)
            : undefined
        const progress: OpenAiStreamProgress = { progressed: false, outputChars: 0 }
        /** Why the call stopped, when the deadline or the caller stopped it. */
        const stopped = (): unknown => {
          if (deadlineHit) {
            return new OpenAiStreamError(
              { kind: 'deadline', timeoutMs: timeout ?? 0 },
              progress,
            )
          }
          if (signal?.aborted === true) {
            return progress.progressed
              ? new OpenAiStreamError({ kind: 'aborted' }, progress, {
                  cause: signal.reason,
                })
              : abortError(signal)
          }
          return undefined
        }
        try {
          let response: Response
          try {
            response = await send(`${OPENAI_BASE_URL}/responses`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
                accept: 'text/event-stream',
              },
              body: JSON.stringify({ ...params, stream: true }),
              signal: controller.signal,
            })
          } catch (err) {
            const why: unknown = stopped() ?? connectionError(err)
            throw why
          }
          const idHeader = response.headers.get('x-request-id')
          const requestId = idHeader !== null && idHeader !== '' ? idHeader : undefined
          if (!response.ok) {
            const err = await statusError(response)
            const why: unknown = stopped() ?? err
            throw why
          }

          const stream = Stream.fromSSEResponse<Record<string, unknown>>(
            response,
            controller,
          )
          const completed = new Map<string, OpenAiOutputItem>()
          let terminal: { type: string; response: unknown } | undefined
          try {
            for await (const event of stream) {
              const type = typeof event['type'] === 'string' ? event['type'] : ''
              if (!NON_OUTPUT_EVENTS.has(type)) progress.progressed = true
              const delta = event['delta']
              if (typeof delta === 'string') progress.outputChars += delta.length
              if (type === 'response.output_item.done') {
                const item = event['item']
                if (
                  isRecord(item) &&
                  typeof item['id'] === 'string' &&
                  item['id'] !== ''
                ) {
                  completed.set(item['id'], item as OpenAiOutputItem)
                }
              }
              if (TERMINAL_STATUS[type] !== undefined) {
                terminal = { type, response: event['response'] }
                break
              }
            }
          } catch (err) {
            const why: unknown = stopped() ?? streamFailure(err, progress, isErrorEvent)
            throw why
          }
          if (terminal === undefined || !isRecord(terminal.response)) {
            const why: unknown =
              stopped() ?? new OpenAiStreamError({ kind: 'ended_early' }, progress)
            throw why
          }
          // A terminal snapshot that already lists output means the model
          // generated, even when no separate output event preceded it.
          const listed = terminal.response['output']
          if (Array.isArray(listed) && listed.length > 0) progress.progressed = true
          const status = TERMINAL_STATUS[terminal.type] as string
          // The event type decides the status (`response.incomplete` is incomplete
          // whatever its object says), as the xAI client does (ADR-040).
          const reconciled = reconcileWithCompletedItems(
            terminal.response as unknown as OpenAiResponseShape,
            completed,
          )
          onResponse?.({
            ...(requestId !== undefined ? { requestId } : {}),
            streamProgressed: progress.progressed,
            ...(reconciled.notes.length > 0 ? { streamNotes: reconciled.notes } : {}),
          })
          return { ...reconciled.response, status }
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
          signal?.removeEventListener('abort', forwardAbort)
        }
      },
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fill in what the terminal response's copy of an item lacks from the item its
 * `response.output_item.done` event completed (matched by `id`). The terminal
 * copy wins for every key it carries; a key only the completed item carries
 * (for example a reasoning item's `encrypted_content`, which the replay needs) is
 * copied in. No item the terminal response does not list is added: the terminal
 * object is the provider's statement of what the response is, and the state
 * replays it; filling gaps keeps that statement and only stops a field the
 * stream did deliver from being lost. When the terminal response has no `output`
 * array at all, the completed items are used in their stream order, with a
 * note (the billed answer is not thrown away for its shape).
 */
function reconcileWithCompletedItems(
  response: OpenAiResponseShape,
  completed: ReadonlyMap<string, OpenAiOutputItem>,
): { response: OpenAiResponseShape; notes: string[] } {
  const notes: string[] = []
  const output = (response as { output?: unknown }).output
  if (!Array.isArray(output)) {
    if (completed.size > 0) {
      notes.push(
        `openai: the terminal response carried no output array; the ${completed.size} item(s) completed by the stream are used.`,
      )
    }
    return { response: { ...response, output: [...completed.values()] }, notes }
  }
  const filled: string[] = []
  const merged = output.map((item: unknown) => {
    if (!isRecord(item) || typeof item['id'] !== 'string') return item as OpenAiOutputItem
    const done = completed.get(item['id'])
    if (done === undefined) return item as OpenAiOutputItem
    const missing = Object.keys(done).filter((key) => !Object.hasOwn(item, key))
    if (missing.length === 0) return item as OpenAiOutputItem
    filled.push(`${item['id']} (${missing.join(', ')})`)
    const copy: Record<string, unknown> = { ...item }
    for (const key of missing) copy[key] = done[key]
    return copy as OpenAiOutputItem
  })
  if (filled.length > 0) {
    notes.push(
      `openai: filled field(s) the terminal response omitted from the completed stream items: ${filled.join('; ')}.`,
    )
  }
  return { response: { ...response, output: merged }, notes }
}

/**
 * The error an aborted caller signal ends in before output began: its reason
 * when that is an `LlmError` (the engine's deadline), else an `AbortError`.
 */
function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  if (reason instanceof LlmError) return reason
  return Object.assign(new Error('Request was aborted.'), {
    name: 'AbortError',
    cause: reason,
  })
}

/**
 * What an error thrown while the stream was read means: an `error` event is
 * {@link OpenAiStreamError} `error_event`; any other failure after output
 * began is `cut` (the raw error is its `cause`); a failure before output is
 * returned untouched and classifies as an HTTP or transport error.
 */
function streamFailure(
  err: unknown,
  progress: OpenAiStreamProgress,
  isErrorEvent: (
    err: unknown,
  ) => err is { code?: string | null | undefined; error?: unknown },
): unknown {
  if (isErrorEvent(err)) {
    const body = err.error as { code?: unknown; message?: unknown } | undefined
    const code =
      typeof err.code === 'string'
        ? err.code
        : typeof body?.code === 'string'
          ? body.code
          : undefined
    const message = typeof body?.message === 'string' ? body.message : undefined
    return new OpenAiStreamError(
      {
        kind: 'error_event',
        ...(code !== undefined ? { code } : {}),
        ...(message !== undefined ? { message } : {}),
      },
      progress,
      { cause: err },
    )
  }
  if (!progress.progressed) return err
  return new OpenAiStreamError(
    { kind: 'cut', detail: err instanceof Error ? err.message : String(err) },
    progress,
    { cause: err },
  )
}
