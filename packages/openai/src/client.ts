/**
 * Structural `OpenAiClientLike` interface + `buildOpenAiClient` factory.
 *
 * The adapter depends only on the structural interface below. The real
 * `openai` SDK is imported ONLY in {@link buildOpenAiClient}, so a test or a
 * runtime smoke can inject a structural client without the SDK. This is the
 * only file in `packages/openai/src` that imports `openai`.
 *
 * Written against the installed `openai` 7.60.0 (`src/client.ts`,
 * `src/lib/responses/ResponseStream.ts`, `src/lib/EventStream.ts`,
 * `src/core/error.ts`, `src/resources/responses/responses.ts`), read
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

/** Parameters the adapter sends to `responses.stream` (the SDK adds `stream: true`). */
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
  /** True when output events arrived before the terminal event. */
  streamProgressed?: boolean
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
// buildOpenAiClient: imports the real `openai` SDK
// ---------------------------------------------------------------------------

/**
 * Build a real `openai`-SDK-backed client from {@link AuthMaterial}.
 *
 * The key is checked before the SDK is imported. Each `create` call builds its
 * own SDK client with every option the SDK would otherwise read from the
 * environment pinned (ADR-019, ADR-047): explicit `apiKey`, explicit
 * `baseURL` ({@link OPENAI_BASE_URL}), `organization: null`, `project: null`,
 * `adminAPIKey: null`, `webhookSecret: null`, `logLevel: 'off'` and
 * `maxRetries: 0` (one HTTP request per attempt; the engine owns retries). The
 * SDK constructor also parses `OPENAI_CUSTOM_HEADERS` into default headers that
 * are applied after the auth header, and no option turns that read off; the
 * client builds the SDK client inside {@link withoutAmbientCustomHeaders}, so
 * the variable is never parsed (a malformed value cannot fail a call) and no
 * environment variable can add or replace a header.
 *
 * The call streams through the SDK's own `responses.stream()` helper. A
 * terminal event (`response.completed`, `response.incomplete` or
 * `response.failed`) is required: a stream that ends cleanly without one is an
 * {@link OpenAiStreamError} (`ended_early`), never the SDK's accumulated
 * snapshot. The SDK `timeout` covers only the wait for response headers on a
 * stream, so `timeout` also arms a client timer over the whole call. The caller's
 * signal is forwarded, its reason kept.
 *
 * @param auth - `{ apiKey }`.
 * @param fetchImpl - Test seam: the `fetch` the SDK uses (defaults to the
 *   global `fetch`). Not exported from the package index.
 */
export async function buildOpenAiClient(
  auth: AuthMaterial,
  fetchImpl?: typeof fetch,
): Promise<OpenAiClientLike> {
  const apiKey = requireApiKey(auth)
  const sdk = await import('openai')
  const OpenAI = sdk.default

  /** An `error` event: the SDK throws an `APIError` with no HTTP status for it. */
  const isErrorEvent = (err: unknown): err is InstanceType<typeof sdk.APIError> =>
    err instanceof sdk.APIError &&
    err.status === undefined &&
    !(err instanceof sdk.APIConnectionError) &&
    !(err instanceof sdk.APIUserAbortError)

  return {
    responses: {
      async create(
        params: OpenAiResponseCreateParams,
        options?: OpenAiRequestOptions,
      ): Promise<OpenAiResponseShape> {
        const { signal, timeout, onResponse } = options ?? {}
        let requestId: string | undefined
        const capturingFetch: typeof fetch = async (input, init) => {
          const response =
            fetchImpl !== undefined
              ? await fetchImpl(input, init)
              : await fetch(input, init)
          const id = response.headers.get('x-request-id')
          if (id !== null && id !== '') requestId = id
          return response
        }
        const client = withoutAmbientCustomHeaders(
          () =>
            new OpenAI({
              apiKey,
              baseURL: OPENAI_BASE_URL,
              organization: null,
              project: null,
              adminAPIKey: null,
              webhookSecret: null,
              logLevel: 'off',
              maxRetries: 0,
              fetch: capturingFetch,
            }),
        )

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
          const stream = client.responses.stream(
            params as unknown as Parameters<typeof client.responses.stream>[0],
            {
              signal: controller.signal,
              ...(timeout !== undefined ? { timeout } : {}),
            },
          )
          // The helper rejects its end promise on failure; the iterator below
          // reports the failure, so the promise is observed here.
          stream.done().catch(() => undefined)
          let terminal: { type: string; response: unknown } | undefined
          try {
            for await (const event of stream) {
              const type = (event as { type: string }).type
              if (!NON_OUTPUT_EVENTS.has(type)) progress.progressed = true
              const delta = (event as { delta?: unknown }).delta
              if (typeof delta === 'string') progress.outputChars += delta.length
              if (TERMINAL_STATUS[type] !== undefined) {
                terminal = { type, response: (event as { response?: unknown }).response }
                break
              }
            }
          } catch (err) {
            const why: unknown = stopped() ?? streamFailure(err, progress, isErrorEvent)
            throw why
          }
          if (terminal === undefined) {
            const why: unknown =
              stopped() ?? new OpenAiStreamError({ kind: 'ended_early' }, progress)
            throw why
          }
          const status = TERMINAL_STATUS[terminal.type] as string
          // The event type decides the status (`response.incomplete` is incomplete
          // whatever its object says), as the xAI client does (ADR-040).
          const response = {
            ...(terminal.response as OpenAiResponseShape),
            status,
          }
          onResponse?.({
            ...(requestId !== undefined ? { requestId } : {}),
            streamProgressed: progress.progressed,
          })
          return response
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
          signal?.removeEventListener('abort', forwardAbort)
        }
      },
    },
  }
}

/** The one environment variable the SDK reads that no constructor option overrides. */
const CUSTOM_HEADERS_VARIABLE = 'OPENAI_CUSTOM_HEADERS'

/**
 * Run `construct` (the SDK constructor) with `OPENAI_CUSTOM_HEADERS` unreadable.
 *
 * `openai` 7.60.0 reads that variable in its constructor through `readEnv`
 * (`src/internal/utils/env.ts`: `globalThis.process.env?.[name]`), unless a
 * `provider` or an X.509 `credential` is configured, which this client never
 * uses; nothing else turns the read off, and `defaultHeaders` is merged after
 * the parsed value rather than replacing it, so a malformed value throws inside
 * `super()`. For the duration of the call `globalThis.process` is replaced by a
 * view of the real `process` whose `env` hides that one variable (every other
 * property and variable passes through untouched), and the original property
 * descriptor is restored in `finally`.
 *
 * Why this is safe: the SDK constructor is synchronous (no `await`, no timer, no
 * callback), so no other code in this JavaScript realm can run while the view is
 * installed, and nothing the constructor starts keeps a reference to it (the
 * constructor reads the variables once and stores the values). The view lives on
 * this realm's `globalThis` only: the OS environment, child processes and worker
 * threads (each has its own `globalThis`) never see a change. No value is read,
 * copied or logged by this library; the view only declines one key. A runtime
 * without a configurable `globalThis.process` calls `construct` unchanged (there,
 * `readEnv` falls back to `Deno.env` on Deno and to nothing elsewhere; Deno 2
 * exposes `process`, so the view applies there too).
 */
function withoutAmbientCustomHeaders<T>(construct: () => T): T {
  const host = globalThis as { process?: unknown }
  const descriptor = Object.getOwnPropertyDescriptor(host, 'process')
  const real = host.process
  if (
    descriptor === undefined ||
    descriptor.configurable !== true ||
    typeof real !== 'object' ||
    real === null
  ) {
    return construct()
  }
  const env = (real as { env?: unknown }).env
  if (typeof env !== 'object' || env === null) return construct()
  const envView = new Proxy(env, {
    get: (target, key) =>
      key === CUSTOM_HEADERS_VARIABLE
        ? undefined
        : (Reflect.get(target, key, target) as unknown),
    has: (target, key) => key !== CUSTOM_HEADERS_VARIABLE && Reflect.has(target, key),
  })
  const view = new Proxy(real, {
    get: (target, key) =>
      key === 'env' ? envView : (Reflect.get(target, key, target) as unknown),
  })
  Object.defineProperty(host, 'process', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    writable: true,
    value: view,
  })
  try {
    return construct()
  } finally {
    Object.defineProperty(host, 'process', descriptor)
  }
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
