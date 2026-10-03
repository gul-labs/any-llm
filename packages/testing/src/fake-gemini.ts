/**
 * fake-gemini — a structural stub of the @google/genai client surface.
 *
 * The Gemini adapter (M4/@gullabs/google) depends on `@google/genai` as a
 * peer-dependency.  Tests must never touch the real network, so this module
 * provides a fully structural (no import of @google/genai) fake that scripts
 * responses, captures calls, and can inject errors.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Response shape (mirrors the @google/genai surface the adapter consumes)
// ---------------------------------------------------------------------------

/**
 * A single content part returned by the Gemini API.
 *
 * - `thought: true` marks a thought-summary part (present when `includeThoughts` requested).
 * - `text` is the string content of the part.
 */
export interface GeminiPartLike {
  text?: string
  /** Present and `true` on thought-summary parts. */
  thought?: boolean
  functionCall?: { id?: string; name?: string; args?: unknown }
  /** Opaque signature Gemini 3.x attaches to the first function call of a turn. */
  thoughtSignature?: string
}

/** The `content` object inside a Gemini candidate. */
export interface GeminiContentLike {
  parts?: GeminiPartLike[]
}

/** A single candidate returned in a Gemini response. */
export interface GeminiCandidateLike {
  content?: GeminiContentLike
  /**
   * Why the model stopped generating.
   * e.g. `'STOP'`, `'MAX_TOKENS'`, `'SAFETY'`, `'OTHER'`.
   */
  finishReason?: string
  /** Grounding metadata returned when Google Search grounding is active. */
  groundingMetadata?: unknown
}

/**
 * The token-usage metadata object returned alongside a Gemini response.
 *
 * All fields are optional because the real SDK may omit them for certain
 * request types or error responses.
 */
export interface GeminiUsageMetadataLike {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  serviceTier?: string
}

/**
 * The structural shape of a Gemini `generateContent` response that the
 * adapter consumes.  Mirrors the subset of `GenerateContentResponse` we
 * actually read — nothing more, so M4 can swap in the real type trivially.
 *
 * When a request is blocked by Gemini's safety system, the real API returns a
 * response with **no candidates** and a populated `promptFeedback` object.
 * `candidates` may be absent or empty in that case.
 */
export interface GeminiResponseLike {
  candidates?: GeminiCandidateLike[]
  usageMetadata?: GeminiUsageMetadataLike
  /** Provider-specific model version string (e.g. `"gemini-2.5-pro-001"`). */
  modelVersion?: string
  /** Provider-assigned response ID. */
  responseId?: string
  /**
   * Safety-block metadata returned when the prompt (not the output) was
   * rejected by Gemini's safety filters.  Present on safety-blocked responses;
   * absent on normal responses.
   *
   * When `blockReason` is set and `candidates` is empty or absent, the adapter
   * should classify the result as `'content_filter'`.
   */
  promptFeedback?: {
    /** E.g. `'SAFETY'`, `'OTHER'`, `'PROHIBITED_CONTENT'`. */
    blockReason?: string
    /** Raw safety rating breakdown (forward-compat; kept as `unknown[]`). */
    safetyRatings?: unknown[]
  }
}

// ---------------------------------------------------------------------------
// Builder: fakeGeminiResponse
// ---------------------------------------------------------------------------

/**
 * Options for {@link fakeGeminiResponse}.
 */
export interface FakeGeminiResponseOpts {
  /**
   * The main text output from the model.
   * Placed in a plain (non-thought) part.
   */
  text?: string
  /**
   * Thought-summary text (placed in a part with `thought: true`).
   * Comes before the main text part in the `parts` array.
   */
  thoughtText?: string
  /**
   * Structured JSON text output (mutually exclusive with `text`; use one or
   * the other).  Placed in a plain part — the adapter does not distinguish
   * JSON text from regular text at the part level.
   */
  structuredJson?: string
  /** Extra candidate parts (e.g. functionCall). Appended after text parts. */
  parts?: GeminiPartLike[]
  // Usage metadata fields
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  /** e.g. `'STOP'` | `'MAX_TOKENS'` | `'SAFETY'` */
  finishReason?: string
  modelVersion?: string
  responseId?: string
  /**
   * Optional grounding metadata to attach to the candidate.
   * Pass a plain object, e.g. `{ webSearchQueries: ['q1'], groundingChunks: [] }`.
   */
  groundingMetadata?: unknown
}

/**
 * Build a {@link GeminiResponseLike} from a concise options object.
 *
 * ```ts
 * const resp = fakeGeminiResponse({
 *   text: 'Hello',
 *   promptTokenCount: 10,
 *   candidatesTokenCount: 5,
 *   finishReason: 'STOP',
 * })
 * ```
 */
export function fakeGeminiResponse(
  opts: FakeGeminiResponseOpts = {},
): GeminiResponseLike {
  // Build the parts array in thought → main order.
  const parts: GeminiPartLike[] = []
  if (opts.thoughtText !== undefined) {
    parts.push({ text: opts.thoughtText, thought: true })
  }
  const mainText = opts.structuredJson ?? opts.text
  if (mainText !== undefined) {
    parts.push({ text: mainText })
  }
  if (opts.parts !== undefined) {
    parts.push(...opts.parts)
  }

  // Build candidate.
  const candidate: GeminiCandidateLike = {
    content: { parts },
    ...(opts.finishReason !== undefined ? { finishReason: opts.finishReason } : {}),
    ...(opts.groundingMetadata !== undefined
      ? { groundingMetadata: opts.groundingMetadata }
      : {}),
  }

  // Build usage metadata — only include defined fields to satisfy
  // exactOptionalPropertyTypes.
  const usageMetadata: GeminiUsageMetadataLike = {
    ...(opts.promptTokenCount !== undefined
      ? { promptTokenCount: opts.promptTokenCount }
      : {}),
    ...(opts.candidatesTokenCount !== undefined
      ? { candidatesTokenCount: opts.candidatesTokenCount }
      : {}),
    ...(opts.cachedContentTokenCount !== undefined
      ? { cachedContentTokenCount: opts.cachedContentTokenCount }
      : {}),
    ...(opts.thoughtsTokenCount !== undefined
      ? { thoughtsTokenCount: opts.thoughtsTokenCount }
      : {}),
    ...(opts.totalTokenCount !== undefined
      ? { totalTokenCount: opts.totalTokenCount }
      : {}),
  }

  return {
    candidates: [candidate],
    usageMetadata,
    ...(opts.modelVersion !== undefined ? { modelVersion: opts.modelVersion } : {}),
    ...(opts.responseId !== undefined ? { responseId: opts.responseId } : {}),
  }
}

// ---------------------------------------------------------------------------
// Builder: fakeGeminiBlocked
// ---------------------------------------------------------------------------

/**
 * Options for {@link fakeGeminiBlocked}.
 */
export interface FakeGeminiBlockedOpts {
  /**
   * The block reason string (e.g. `'SAFETY'`, `'PROHIBITED_CONTENT'`).
   * Defaults to `'SAFETY'` when omitted.
   */
  blockReason?: string
  /**
   * Optional safety rating details to include in `promptFeedback`.
   * Passed through verbatim; the adapter treats this as opaque metadata.
   */
  safetyRatings?: unknown[]
}

/**
 * Build a {@link GeminiResponseLike} that represents a safety-blocked response.
 *
 * Real `@google/genai` safety-blocked responses surface via `promptFeedback`
 * (with `blockReason` set) and return **no candidates**.  The Gemini adapter
 * (M5) must classify such responses as `'content_filter'`.
 *
 * Use this builder in adapter tests that exercise the `content_filter` error
 * path.
 *
 * ```ts
 * const client = makeFakeGemini(fakeGeminiBlocked({ blockReason: 'SAFETY' }))
 * // adapter should throw LlmError { kind: 'content_filter' }
 * ```
 */
export function fakeGeminiBlocked(opts: FakeGeminiBlockedOpts = {}): GeminiResponseLike {
  const { blockReason = 'SAFETY', safetyRatings } = opts

  const promptFeedback: NonNullable<GeminiResponseLike['promptFeedback']> = {
    blockReason,
    ...(safetyRatings !== undefined ? { safetyRatings } : {}),
  }

  return {
    candidates: [],
    promptFeedback,
  }
}

// ---------------------------------------------------------------------------
// countTokens response shape
// ---------------------------------------------------------------------------

/**
 * The structural shape of a Gemini `countTokens` response that the adapter
 * consumes.  Mirrors the subset of `CountTokensResponse` we actually read.
 */
export interface GeminiCountTokensResponseLike {
  totalTokens?: number
  cachedContentTokenCount?: number
}

// ---------------------------------------------------------------------------
// Script type for makeFakeGemini
// ---------------------------------------------------------------------------

/**
 * A script that controls what {@link makeFakeGemini} returns.
 *
 * - **Single response** — every call returns the same response.
 * - **Array of responses** — calls are served sequentially (first call gets
 *   `script[0]`, second gets `script[1]`, etc.).  Throws `RangeError` when
 *   the script is exhausted.
 * - **Function** — called with the raw `params` on each invocation.  May
 *   return a response or throw synchronously (including throwing a plain
 *   object like `{ status: 429 }` for error-classification tests).
 */
export type GeminiScript =
  | GeminiResponseLike
  | GeminiResponseLike[]
  | ((params: unknown) => GeminiResponseLike | Promise<GeminiResponseLike>)

/**
 * A script that controls what {@link makeFakeGemini}'s `countTokens` fake
 * returns. Same shape convention as {@link GeminiScript}. Defaults to
 * `{ totalTokens: 0 }` when `makeFakeGemini` is called without a second
 * argument, so existing call sites that only exercise `generateContent`
 * keep compiling and running unchanged.
 */
export type GeminiCountTokensScript =
  | GeminiCountTokensResponseLike
  | GeminiCountTokensResponseLike[]
  | ((
      params: unknown,
    ) => GeminiCountTokensResponseLike | Promise<GeminiCountTokensResponseLike>)

// ---------------------------------------------------------------------------
// Fake client shape
// ---------------------------------------------------------------------------

/**
 * The minimal structural surface of the @google/genai `GoogleGenAI` client
 * that the adapter accesses.
 */
export interface FakeGeminiModels {
  generateContent(params: unknown): Promise<GeminiResponseLike>
  countTokens(params: unknown): Promise<GeminiCountTokensResponseLike>
}

/**
 * The object returned by {@link makeFakeGemini}.
 *
 * Structurally compatible with the subset of `GoogleGenAI` the adapter uses.
 * The extra `calls` / `countTokensCalls` arrays are for test assertions.
 */
export interface FakeGeminiClient {
  /** Drop-in replacement for `new GoogleGenAI(...).models`. */
  readonly models: FakeGeminiModels
  /**
   * Every argument object passed to `models.generateContent()`, in order.
   * Inspect this in tests to assert the adapter constructed the right params.
   */
  readonly calls: unknown[]
  /**
   * Every argument object passed to `models.countTokens()`, in order.
   * Inspect this in tests to assert the adapter constructed the right params.
   */
  readonly countTokensCalls: unknown[]
}

// ---------------------------------------------------------------------------
// makeFakeGemini
// ---------------------------------------------------------------------------

/**
 * Create a fake @google/genai client that serves scripted responses.
 *
 * ```ts
 * // Sequential responses
 * const client = makeFakeGemini([
 *   fakeGeminiResponse({ text: 'first' }),
 *   fakeGeminiResponse({ text: 'second' }),
 * ])
 * await client.models.generateContent({})  // → first response
 * await client.models.generateContent({})  // → second response
 * expect(client.calls).toHaveLength(2)
 *
 * // Error injection (mimics a 429 object thrown by the real SDK)
 * const errorClient = makeFakeGemini(() => { throw { status: 429 } })
 * await expect(errorClient.models.generateContent({})).rejects.toMatchObject({ status: 429 })
 * ```
 */
export function makeFakeGemini(
  script: GeminiScript,
  countTokensScript: GeminiCountTokensScript = { totalTokens: 0 },
): FakeGeminiClient {
  const calls: unknown[] = []
  const countTokensCalls: unknown[] = []
  let callIndex = 0
  let countTokensCallIndex = 0

  const generateContent = async (params: unknown): Promise<GeminiResponseLike> => {
    calls.push(params)

    if (typeof script === 'function') {
      return await script(params)
    }

    if (Array.isArray(script)) {
      const response = script[callIndex]
      if (response === undefined) {
        throw new RangeError(
          `makeFakeGemini: script exhausted after ${callIndex} call(s); no response for call ${
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

  const countTokens = async (params: unknown): Promise<GeminiCountTokensResponseLike> => {
    countTokensCalls.push(params)

    if (typeof countTokensScript === 'function') {
      return await countTokensScript(params)
    }

    if (Array.isArray(countTokensScript)) {
      const response = countTokensScript[countTokensCallIndex]
      if (response === undefined) {
        throw new RangeError(
          `makeFakeGemini: countTokens script exhausted after ${countTokensCallIndex} call(s); ` +
            `no response for call ${countTokensCallIndex + 1}`,
        )
      }
      countTokensCallIndex += 1
      return response
    }

    // Single response — always return the same value.
    return countTokensScript
  }

  return {
    models: { generateContent, countTokens },
    calls,
    countTokensCalls,
  }
}
