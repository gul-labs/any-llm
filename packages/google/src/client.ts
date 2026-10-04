/**
 * Structural GeminiClientLike interface + buildGoogleClient factory.
 *
 * This module defines the structural interface the adapter depends on.
 * The real @google/genai SDK is imported ONLY in buildGoogleClient so tests
 * can inject a fake without pulling in the real SDK.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { AuthMaterial } from '@gullabs/core'
import type { GoogleGenAI } from '@google/genai'

// ---------------------------------------------------------------------------
// Auth narrowing — Google only accepts ApiKeyAuth
// ---------------------------------------------------------------------------

/**
 * Narrows {@link AuthMaterial} to its `apiKey` string, rejecting the
 * dev-only `CliSessionAuth` variant.
 *
 * Google is a production API provider and only ever accepts API-key
 * credentials; `{ cliSession: true }` is reserved for the dev-only CLI
 * provider packages (`@gullabs/claude-cli`, `@gullabs/codex-cli`).
 */
export function requireApiKey(auth: AuthMaterial): string {
  if (
    !('apiKey' in auth) ||
    typeof auth.apiKey !== 'string' ||
    auth.apiKey.trim() === ''
  ) {
    throw new LlmError('@gullabs/google requires auth.apiKey', {
      kind: 'invalid_auth',
      retryable: false,
      provider: 'google',
    })
  }
  return auth.apiKey
}

// ---------------------------------------------------------------------------
// Transport timeout defaults
// ---------------------------------------------------------------------------

/**
 * Default HTTP transport timeout for Gemini Flex service-tier calls (ms).
 *
 * The default per-attempt transport (httpOptions) timeout applied ONLY when a
 * flex call provides no explicit `timeoutMs`. Set to 25 minutes (1_500_000 ms)
 * to cover the ~20-minute flex workload ceiling with margin.  The @google/genai
 * SDK defaults to 1 minute, which would terminate a long flex call prematurely.
 * Callers SHOULD still set `timeoutMs` for a precise per-attempt ceiling; this
 * value is only the backstop for callers that do not.
 */
export const FLEX_DEFAULT_TIMEOUT_MS = 1_500_000

/**
 * Default HTTP transport timeout for Gemini standard-tier calls (ms).
 *
 * Used when a standard-tier request has no explicit `timeoutMs`. The adapter
 * also backs this with an AbortController so the limit is a real client-side
 * ceiling, not only an SDK transport hint.
 */
export const STANDARD_DEFAULT_TIMEOUT_MS = 300_000

/**
 * Buffer added above `timeoutMs` when setting the SDK transport timeout.
 *
 * When `timeoutMs` is set, the engine arms an AbortSignal at exactly
 * `timeoutMs`.  If the SDK transport timer fired at the same instant it
 * could preempt the signal and produce a raw SDK error instead of the
 * engine's clean `kind:'timeout'`.  By setting the transport timeout to
 * `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS` we ensure the engine's
 * AbortSignal always fires first.
 */
export const TRANSPORT_TIMEOUT_BUFFER_MS = 5_000

/**
 * Largest delay a Node timer holds: above 2^31 - 1 ms a timer fires after 1 ms
 * (with a warning). The SDK arms one for every `httpOptions.timeout`, so a
 * larger transport timeout is rejected, not clamped.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Largest `timeoutMs` the gemini config schemas accept. The SDK deadline is
 * `timeoutMs` plus {@link TRANSPORT_TIMEOUT_BUFFER_MS} and must itself fit a
 * timer ({@link MAX_TIMER_MS}); a larger value is rejected, not clamped.
 */
export const GOOGLE_MAX_TIMEOUT_MS = MAX_TIMER_MS - TRANSPORT_TIMEOUT_BUFFER_MS

// ---------------------------------------------------------------------------
// Response shape — mirrors the @google/genai surface we actually consume
// ---------------------------------------------------------------------------

/** A single text/thought part in a Gemini candidate content. */
export interface GeminiPartShape {
  text?: string
  /**
   * Present and `true` on thought-summary parts.
   * Real field name in @google/genai Candidate.content.parts: `thought`.
   */
  thought?: boolean
  functionCall?: { id?: string; name?: string; args?: unknown }
  /**
   * Opaque signature Gemini 3.x attaches to the first function call of a turn
   * (and sometimes to text parts). Real field: `Part.thoughtSignature`.
   */
  thoughtSignature?: string
}

/** A candidate returned by Gemini generateContent. */
export interface GeminiCandidateShape {
  content?: {
    parts?: GeminiPartShape[]
  }
  /**
   * Why the model stopped.
   * Real SDK enum (FinishReason): "STOP", "MAX_TOKENS", "SAFETY",
   * "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", etc.
   */
  finishReason?: string
  /** Human-readable detail Google sends with some finish reasons. */
  finishMessage?: string
  /** Per-category safety ratings of the candidate. */
  safetyRatings?: unknown[]
  /** Source-attribution metadata for recited content. */
  citationMetadata?: unknown
  /** Retrieval status of each URL the model was asked to read. */
  urlContextMetadata?: unknown
  /**
   * Grounding metadata returned when Google Search grounding is active.
   * Real SDK type: GroundingMetadata. Kept as `unknown` to avoid a hard
   * coupling to @google/genai types; cast to JsonValue at the adapter boundary.
   */
  groundingMetadata?: unknown
}

/**
 * Token usage metadata returned alongside a Gemini response.
 *
 * Real type: GenerateContentResponseUsageMetadata.
 * NOTE: thoughtsTokenCount is SEPARATE from candidatesTokenCount.
 * The adapter must add them to get GROSS outputTokens.
 */
export interface GeminiUsageMetadataShape {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  /** Tokens of tool results fed back to the model (Search results on Gemini 2.5). */
  toolUsePromptTokenCount?: number
  totalTokenCount?: number
  /** Provider-echoed actual tier; can differ from the requested tier. */
  serviceTier?: string
  /**
   * Prompt tokens per modality (`TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`);
   * the counts sum to `promptTokenCount` and include the cached part.
   */
  promptTokensDetails?: GeminiModalityTokenCount[]
  /** The cached part of the prompt per modality, when a cache was used. */
  cacheTokensDetails?: GeminiModalityTokenCount[]
}

/** One entry of `usageMetadata.promptTokensDetails` / `cacheTokensDetails`. */
export interface GeminiModalityTokenCount {
  modality?: string
  tokenCount?: number
}

/**
 * Structural equivalent of @google/genai's GenerateContentResponse.
 * Only the fields the adapter reads are represented here.
 */
export interface GeminiResponseShape {
  candidates?: GeminiCandidateShape[]
  usageMetadata?: GeminiUsageMetadataShape
  /** Real field: GenerateContentResponse.modelVersion */
  modelVersion?: string
  /** Real field: GenerateContentResponse.responseId */
  responseId?: string
  /**
   * Safety-block metadata.
   * Real type: GenerateContentResponsePromptFeedback.
   * Present when the prompt (not output) was blocked by safety filters.
   */
  promptFeedback?: {
    /** Real type: BlockedReason (string enum). e.g. "SAFETY", "OTHER". */
    blockReason?: string
    blockReasonMessage?: string
    safetyRatings?: unknown[]
  }
}

// ---------------------------------------------------------------------------
// Request / config shape — what the adapter sends to generateContent
// ---------------------------------------------------------------------------

/**
 * Per-part media-resolution hint emitted on inline/file parts.
 * Real type: @google/genai `PartMediaResolution`; `level` values come from
 * the `PartMediaResolutionLevel` string enum (we only emit the LOW/MEDIUM/HIGH
 * subset our normalized `mediaResolution` maps to).
 */
export interface GeminiPartMediaResolution {
  level?: 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH'
}

/** A text part in a content object we construct. */
export interface GeminiTextContentPart {
  text: string
  /** Replayed signature for this part (real field: `Part.thoughtSignature`). */
  thoughtSignature?: string
}

/**
 * An inline binary media part in a content object we construct.
 * `data` must be raw base64 — no `data:…;base64,` prefix.
 */
export interface GeminiInlineDataContentPart {
  inlineData: {
    /** IANA media type, e.g. `"image/png"`. */
    mimeType: string
    /** Raw base64-encoded bytes (no data-URL prefix). */
    data: string
  }
  /** Optional per-part media-resolution hint (real field: `Part.mediaResolution`). */
  mediaResolution?: GeminiPartMediaResolution
}

/**
 * A provider-hosted file reference part in a content object we construct.
 * The Gemini service dereferences `fileUri` server-side.
 */
export interface GeminiFileDataContentPart {
  fileData: {
    /** IANA media type of the referenced file. */
    mimeType: string
    /** Provider-assigned file URI, e.g. from the Gemini File API. */
    fileUri: string
  }
  /** Optional per-part media-resolution hint (real field: `Part.mediaResolution`). */
  mediaResolution?: GeminiPartMediaResolution
}

/**
 * Union of all part shapes the adapter may produce for `GeminiContent.parts`.
 * Each member (including the optional per-part `mediaResolution`) is a
 * structural subset of the real `@google/genai` `Part` type for the fields we use.
 */
export interface GeminiFunctionCallPart {
  functionCall: { id?: string; name: string; args?: unknown }
  /** Replayed signature for this call (real field: `Part.thoughtSignature`). */
  thoughtSignature?: string
}

export interface GeminiFunctionResponsePart {
  functionResponse: { id?: string; name: string; response: unknown }
}

export type GeminiContentPart =
  | GeminiTextContentPart
  | GeminiInlineDataContentPart
  | GeminiFileDataContentPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart

/** A content object (message) we construct. */
export interface GeminiContent {
  role: string
  parts: GeminiContentPart[]
}

/**
 * Thinking configuration.
 * Real type: ThinkingConfig in @google/genai.
 * - thinkingBudget: 0 = DISABLED, -1 = AUTOMATIC
 * - thinkingLevel: ThinkingLevel enum ("LOW", "MEDIUM", "HIGH", "MINIMAL")
 */
export interface GeminiThinkingConfig {
  includeThoughts?: boolean
  thinkingBudget?: number
  /**
   * Real type: ThinkingLevel enum.
   * Values: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL" | "THINKING_LEVEL_UNSPECIFIED"
   */
  thinkingLevel?: string
}

/**
 * Config object passed in GenerateContentParameters.config.
 * Real type: GenerateContentConfig.
 * abortSignal is inside config, NOT in the top-level params.
 */
export interface GeminiGenerateConfig {
  systemInstruction?: { parts: GeminiContentPart[] }
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  responseMimeType?: string
  /**
   * Standard JSON Schema for the response, sent verbatim (real field:
   * `GenerateContentConfig.responseJsonSchema`). Never `responseSchema`, the
   * OpenAPI-dialect field (ADR-034).
   */
  responseJsonSchema?: unknown
  thinkingConfig?: GeminiThinkingConfig
  /** Real type: ServiceTier enum. Values: "flex" | "standard". */
  serviceTier?: string
  /** Real field: GenerateContentConfig.abortSignal (NOT in top-level params). */
  abortSignal?: AbortSignal
  /**
   * Per-request HTTP options forwarded to the @google/genai transport.
   * We use this to set a transport-level timeout that is >= the AbortSignal
   * deadline so the SDK fetch does not preempt the abort.
   *
   * Real field: GenerateContentConfig.httpOptions.timeout (milliseconds). No
   * other `httpOptions` field is admitted.
   */
  httpOptions?: { timeout?: number }
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string
      description: string
      /** Standard JSON Schema, verbatim (real field: `parametersJsonSchema`). */
      parametersJsonSchema?: unknown
    }>
    googleSearch?: Record<string, never>
  }>
  toolConfig?: {
    functionCallingConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE'
      allowedFunctionNames?: string[]
    }
  }
}

/**
 * Parameters for models.generateContent.
 * Real type: GenerateContentParameters.
 */
export interface GeminiGenerateParams {
  model: string
  contents: GeminiContent[]
  config?: GeminiGenerateConfig
}

/**
 * Parameters for counting tokens.
 *
 * With only `model` and `contents` the call is the SDK's `models.countTokens`.
 * With `systemInstruction` or `tools` the Developer API's SDK method cannot
 * carry them (it throws), so `buildGoogleClient` sends the REST `countTokens`
 * with a full `generateContentRequest` instead; the two forms are mutually
 * exclusive on the wire, so `contents` then travels inside the request.
 */
export interface GeminiCountTokensParams {
  model: string
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiContentPart[] }
  tools?: NonNullable<GeminiGenerateConfig['tools']>
  config?: {
    /**
     * Real field: CountTokensConfig.abortSignal. countTokens has no
     * tier-timeout dance (no flex/standard default ceilings): `ctx.signal`
     * is forwarded here directly, unlike `run()`'s combined timer signal.
     */
    abortSignal?: AbortSignal
  }
}

/**
 * Response shape for models.countTokens.
 * Real type: CountTokensResponse.
 */
export interface GeminiCountTokensResponseShape {
  totalTokens?: number
  cachedContentTokenCount?: number
}

// ---------------------------------------------------------------------------
// GeminiClientLike — structural interface (no @google/genai dependency)
// ---------------------------------------------------------------------------

/**
 * Structural interface for the @google/genai client surface the adapter uses.
 *
 * Satisfied by:
 * - The real GoogleGenAI client (via buildGoogleClient wrapper).
 * - FakeGeminiClient from @gullabs/testing (its generateContent/countTokens
 *   accept unknown).
 */
export interface GeminiClientLike {
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiResponseShape>
    countTokens(params: GeminiCountTokensParams): Promise<GeminiCountTokensResponseShape>
  }
}

// ---------------------------------------------------------------------------
// buildGoogleClient — imports the real @google/genai SDK
// ---------------------------------------------------------------------------

/**
 * Root of the Gemini Developer API. The SDK client is built with it as its
 * explicit `baseUrl` and the REST `countTokens` below builds its URL from it,
 * so one endpoint serves every call. Pinning it also keeps the SDK from taking
 * a base URL out of the process environment (`GOOGLE_GEMINI_BASE_URL`), which
 * would send the call's API key to a host the caller never named.
 */
const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com'

/**
 * A real `GoogleGenAI` client for `auth`, pinned to {@link GEMINI_API_ROOT}.
 * Shared by the generation client and both stores.
 *
 * @internal
 */
export async function newGoogleGenAI(auth: AuthMaterial): Promise<GoogleGenAI> {
  const { GoogleGenAI: Sdk } = await import('@google/genai')
  return new Sdk({
    apiKey: requireApiKey(auth),
    httpOptions: { baseUrl: `${GEMINI_API_ROOT}/` },
  })
}

/**
 * Build a real @google/genai client from AuthMaterial.
 *
 * Returns a GeminiClientLike wrapper around the real GoogleGenAI client.
 * Only API-key authentication is supported; Vertex AI is not.
 *
 * @param auth - API key credentials ({ apiKey }).
 */
export async function buildGoogleClient(auth: AuthMaterial): Promise<GeminiClientLike> {
  // Import the real SDK — only called at runtime when no client is injected.
  // The cast is safe: GeminiGenerateParams is a structural subset of
  // GenerateContentParameters; GeminiResponseShape is a subset of
  // GenerateContentResponse.
  const ai = await newGoogleGenAI(auth)

  return {
    models: {
      async generateContent(params: GeminiGenerateParams): Promise<GeminiResponseShape> {
        // Cast needed: our structural types are subsets of the real SDK types.
        const result = await (
          ai.models.generateContent as (params: unknown) => Promise<GeminiResponseShape>
        )(params)
        return result
      },
      async countTokens(
        params: GeminiCountTokensParams,
      ): Promise<GeminiCountTokensResponseShape> {
        if (params.systemInstruction !== undefined || params.tools !== undefined) {
          return countTokensWithRequest(requireApiKey(auth), params)
        }
        // Cast needed: our structural types are subsets of the real SDK types.
        const result = await (
          ai.models.countTokens as (
            params: unknown,
          ) => Promise<GeminiCountTokensResponseShape>
        )(params)
        return result
      },
    },
  }
}

// ---------------------------------------------------------------------------
// REST countTokens with a full generateContentRequest
// ---------------------------------------------------------------------------

/**
 * Base of the Gemini Developer API (`v1beta`), the version the SDK's Developer
 * API client uses. Only the REST `countTokens` below builds a URL itself.
 */
const GEMINI_API_BASE = `${GEMINI_API_ROOT}/v1beta`

/** Longest non-structured error body kept in an error message (characters). */
const MAX_ERROR_BODY_CHARS = 500

/**
 * `models.countTokens` with `systemInstruction` and `tools`.
 *
 * The SDK's Developer API `countTokens` throws on both fields, but the REST
 * method accepts a `generateContentRequest` (a `GenerateContentRequest` with a
 * `models/<id>` name), which counts the whole request. `model` and `contents`
 * are mutually exclusive with it (ai.google.dev/api/tokens, dated 2026-08-17,
 * read 2026-10-03), so `contents` goes inside it.
 *
 * A non-2xx response is thrown as the SDK's own `ApiError` (status plus the
 * JSON body as the message), so `classifyGoogleError` reads it exactly like a
 * `generateContent` failure. `fetch` is the global, resolved per call.
 */
async function countTokensWithRequest(
  apiKey: string,
  params: GeminiCountTokensParams,
): Promise<GeminiCountTokensResponseShape> {
  const { ApiError } = await import('@google/genai')
  const model = params.model.startsWith('models/')
    ? params.model
    : `models/${params.model}`
  const response = await fetch(`${GEMINI_API_BASE}/${model}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      generateContentRequest: {
        model,
        contents: params.contents,
        ...(params.systemInstruction !== undefined
          ? { systemInstruction: params.systemInstruction }
          : {}),
        ...(params.tools !== undefined ? { tools: params.tools } : {}),
      },
    }),
    ...(params.config?.abortSignal !== undefined
      ? { signal: params.config.abortSignal }
      : {}),
  })
  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    // A structured `{ error: {...} }` body is passed on as sent. Anything else
    // (an HTML proxy page, a JSON body of another shape, an unparseable one) is
    // wrapped with its text cut short, so a page cannot flood the message.
    const body =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === 'object'
        ? parsed
        : {
            error: {
              message:
                raw.length > MAX_ERROR_BODY_CHARS
                  ? `${raw.slice(0, MAX_ERROR_BODY_CHARS)}…`
                  : raw,
              code: response.status,
              status: response.statusText,
            },
          }
    throw new ApiError({ message: JSON.stringify(body), status: response.status })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new LlmError('Gemini countTokens response is not a JSON object', {
      kind: 'server',
      retryable: true,
      provider: 'google',
    })
  }
  return parsed
}
