/**
 * fake-xai — a structural stub of the `openai` SDK's `client.responses`
 * surface used by the xAI Grok adapter.
 *
 * The xAI adapter (`@gullabs/xai`) depends on `openai` as a peer-dependency.
 * Tests must never touch the real network, so this module provides a fully
 * structural (no import of `openai` or `@gullabs/xai`) fake that scripts
 * responses, captures calls, and can inject errors. The fake re-derives the xAI
 * Responses API shapes structurally rather than importing them (`openai` and
 * `@gullabs/xai` are optional peers of this package, loaded only by the error
 * factories). It sits above the adapter's streaming client and returns the final
 * response; to script a failure inside an open stream, throw
 * `fakeStreamFailure()` from a `FakeAdapter` instead.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Response shape (mirrors the xAI Responses API surface the adapter consumes)
// ---------------------------------------------------------------------------

/** A single summary-text segment of a `type: 'reasoning'` output item. */
export interface XaiReasoningSummaryPartLike {
  type: 'summary_text'
  text: string
}

/** A `type: 'reasoning'` item in `output`. */
export interface XaiReasoningOutputItemLike {
  type: 'reasoning'
  id?: string
  summary: XaiReasoningSummaryPartLike[]
  status?: string
}

/** A single text content segment of a `type: 'message'` output item. */
export interface XaiOutputTextPartLike {
  type: 'output_text'
  text: string
  logprobs?: unknown[]
  annotations?: unknown[]
}

/** A `type: 'message'` item in `output`. */
export interface XaiMessageOutputItemLike {
  type: 'message'
  id?: string
  role?: string
  status?: string
  content: XaiOutputTextPartLike[]
}

/** A `type: 'function_call'` item in `output`: the model asks for a tool to be run. */
export interface XaiFunctionCallOutputItemLike {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  /** The call's arguments as the API sends them: a JSON string. */
  arguments: string
  status?: string
  /** The API may add fields; the adapter's own output-item type is open in the same way. */
  [otherKeys: string]: unknown
}

/** Union of output-item shapes the Responses API may return. */
export type XaiOutputItemLike =
  XaiReasoningOutputItemLike | XaiMessageOutputItemLike | XaiFunctionCallOutputItemLike

/**
 * Token usage metadata returned alongside an xAI response.
 *
 * `input_tokens`/`output_tokens` are required to stay structurally
 * assignable to `XaiUsageShape` from `@gullabs/xai`'s `client.ts` (which
 * declares them as required, matching the real API's guaranteed fields) —
 * {@link fakeXaiResponse} defaults both to `0` when not supplied. The rest
 * remain optional/loose since the real API may omit them for certain
 * request types, and has been observed to add additional provider-specific
 * numeric fields.
 */
export interface XaiUsageLike {
  input_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
  [otherKeys: string]: unknown
}

/**
 * The structural shape of an xAI Responses API response that the adapter
 * consumes. Mirrors the subset of the real response body we actually read —
 * nothing more, so the adapter can swap in the real type trivially.
 *
 * `id`, `model`, `status`, `output`, and `usage` are required (not optional)
 * to stay structurally assignable to `XaiResponseShape` from
 * `@gullabs/xai`'s `client.ts` (which declares them as required) —
 * {@link fakeXaiResponse} always populates all five, so this is a
 * zero-cost tightening, not a behavior change.
 */
export interface XaiResponseLike {
  id: string
  model: string
  /** Observed values: `'completed'`, `'incomplete'`. */
  status: string
  incomplete_details?: { reason?: string } | null
  output: XaiOutputItemLike[]
  usage: XaiUsageLike
  reasoning?: { effort?: string; summary?: string }
  /** Echoed served tier. Observed values: `'default'`, `'priority'`. */
  service_tier?: string
  store?: boolean
  prompt_cache_key?: string | null
  citations?: unknown
}

// ---------------------------------------------------------------------------
// Builder: fakeXaiResponse
// ---------------------------------------------------------------------------

/**
 * Options for {@link fakeXaiResponse}.
 */
export interface FakeXaiResponseOpts {
  /**
   * The main text output from the model.
   * Placed in an `output_text` part of a `type: 'message'` output item.
   */
  text?: string
  /**
   * Reasoning summary text (placed in a `type: 'reasoning'` output item,
   * ordered before the message item — mirrors the live API's ordering).
   */
  reasoningText?: string
  /**
   * Structured JSON text output (mutually exclusive with `text`; use one or
   * the other). Placed in the same `output_text` part — the adapter does
   * not distinguish JSON text from regular text at the part level.
   */
  structuredJson?: string
  // Usage metadata fields
  inputTokens?: number
  cachedTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  /** e.g. `'completed'` | `'incomplete'` */
  status?: string
  incompleteReason?: string
  id?: string
  model?: string
  promptCacheKey?: string
  /** Echoed Responses `service_tier` (e.g. `'priority'`). */
  serviceTier?: string
  /**
   * Extra top-level numeric usage fields (e.g. `num_server_side_tools_used`
   * when attachment_search ran). Merged into the usage object for adapter tests.
   */
  usageExtras?: Record<string, number>
  /**
   * Function calls the model makes, placed after the message item. `arguments`
   * may be an object (serialized to JSON) or a string sent as written, for a
   * test of arguments that are not JSON. `status` defaults to `'completed'`.
   */
  functionCalls?: Array<{
    callId: string
    name: string
    arguments: string | Record<string, unknown>
    status?: string
  }>
}

/**
 * Build an {@link XaiResponseLike} from a concise options object.
 *
 * ```ts
 * const resp = fakeXaiResponse({
 *   text: 'Hello',
 *   reasoningText: 'thinking...',
 *   inputTokens: 10,
 *   outputTokens: 5,
 *   status: 'completed',
 * })
 * ```
 */
export function fakeXaiResponse(opts: FakeXaiResponseOpts = {}): XaiResponseLike {
  const output: XaiOutputItemLike[] = []

  if (opts.reasoningText !== undefined) {
    output.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: opts.reasoningText }],
      status: 'completed',
    })
  }

  const mainText = opts.structuredJson ?? opts.text
  if (mainText !== undefined) {
    output.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: mainText }],
    })
  }

  for (const call of opts.functionCalls ?? []) {
    output.push({
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments:
        typeof call.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call.arguments),
      status: call.status ?? 'completed',
    })
  }

  const usage: XaiUsageLike = {
    input_tokens: opts.inputTokens ?? 0,
    output_tokens: opts.outputTokens ?? 0,
    ...(opts.cachedTokens !== undefined
      ? { input_tokens_details: { cached_tokens: opts.cachedTokens } }
      : {}),
    ...(opts.reasoningTokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: opts.reasoningTokens } }
      : {}),
    ...(opts.totalTokens !== undefined ? { total_tokens: opts.totalTokens } : {}),
    ...(opts.usageExtras !== undefined ? opts.usageExtras : {}),
  }

  return {
    id: opts.id ?? 'fake-xai-response-id',
    model: opts.model ?? 'grok-4.5',
    status: opts.status ?? 'completed',
    incomplete_details:
      opts.incompleteReason !== undefined ? { reason: opts.incompleteReason } : null,
    output,
    usage,
    ...(opts.promptCacheKey !== undefined
      ? { prompt_cache_key: opts.promptCacheKey }
      : {}),
    ...(opts.serviceTier !== undefined ? { service_tier: opts.serviceTier } : {}),
  }
}

// ---------------------------------------------------------------------------
// Script type for makeFakeXai
// ---------------------------------------------------------------------------

/**
 * A script that controls what {@link makeFakeXai} returns.
 *
 * - **Single response** — every call returns the same response.
 * - **Array of responses** — calls are served sequentially (first call gets
 *   `script[0]`, second gets `script[1]`, etc.). Throws `RangeError` when
 *   the script is exhausted.
 * - **Function** — called with the raw `params` on each invocation. May
 *   return a response or throw synchronously (including throwing a plain
 *   object like `{ status: 429 }` for error-classification tests).
 */
export type XaiScript =
  | XaiResponseLike
  | XaiResponseLike[]
  | ((params: unknown) => XaiResponseLike | Promise<XaiResponseLike>)

// ---------------------------------------------------------------------------
// Fake client shape
// ---------------------------------------------------------------------------

/**
 * The object returned by {@link makeFakeXai}.
 *
 * Structurally compatible with the subset of the `openai` SDK's
 * `client.responses` the adapter uses. The extra `calls` array is for test
 * assertions.
 */
export interface FakeXaiClient {
  /** Drop-in replacement for `new OpenAI(...).responses`. */
  readonly responses: {
    create(params: unknown, options?: { signal?: AbortSignal }): Promise<XaiResponseLike>
  }
  /**
   * Every argument object passed to `responses.create()`, in order.
   * Inspect this in tests to assert the adapter constructed the right params.
   */
  readonly calls: unknown[]
}

// ---------------------------------------------------------------------------
// makeFakeXai
// ---------------------------------------------------------------------------

/**
 * Create a fake xAI Responses API client that serves scripted responses.
 *
 * ```ts
 * // Sequential responses
 * const client = makeFakeXai([
 *   fakeXaiResponse({ text: 'first' }),
 *   fakeXaiResponse({ text: 'second' }),
 * ])
 * await client.responses.create({})  // → first response
 * await client.responses.create({})  // → second response
 * expect(client.calls).toHaveLength(2)
 *
 * // Error injection: the real SDK error class, which the real adapter classifies
 * const errorClient = makeFakeXai(() => { throw fakeProviderError('xai', 'credits-exhausted-429') })
 * await expect(errorClient.responses.create({})).rejects.toMatchObject({ status: 429 })
 * ```
 */
export function makeFakeXai(script: XaiScript): FakeXaiClient {
  const calls: unknown[] = []
  let callIndex = 0

  // `options` (e.g. `{ signal }`) is accepted for structural compatibility
  // with `XaiClientLike.responses.create` but intentionally ignored — the
  // fake never actually performs I/O, so there is nothing to abort.
  const create = async (
    params: unknown,
    _options?: { signal?: AbortSignal },
  ): Promise<XaiResponseLike> => {
    calls.push(params)

    if (typeof script === 'function') {
      return await script(params)
    }

    if (Array.isArray(script)) {
      const response = script[callIndex]
      if (response === undefined) {
        throw new RangeError(
          `makeFakeXai: script exhausted after ${callIndex} call(s); no response for call ${
            callIndex + 1
          }`,
        )
      }
      callIndex += 1
      return response
    }

    // Single response — always return the same value.
    return script
  }

  return {
    responses: { create },
    calls,
  }
}
