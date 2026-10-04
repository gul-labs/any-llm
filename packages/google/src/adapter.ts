/**
 * geminiAdapter — @gullabs/google Gemini provider adapter.
 *
 * Pure request⇄response mapping over @google/genai (via GeminiClientLike).
 * Never persists, never computes cost, never loops.
 *
 * @module
 */

import {
  LlmError,
  assertNever,
  assertJsonSchemaProfile,
  assertInputMimeTypesAdmitted,
  assertModelMatchesDescriptor,
  isMediaTypeAdmitted,
} from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Scheduler,
  TimerHandle,
  Usage,
  Warning,
  FinishReason,
  JsonValue,
  AuthMaterial,
  Part,
  Message,
  TokenCountRequest,
  TokenCount,
  ToolChoice,
} from '@gullabs/core'
import {
  buildGoogleClient,
  FLEX_DEFAULT_TIMEOUT_MS,
  MAX_TIMER_MS,
  STANDARD_DEFAULT_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from './client.js'
import {
  GOOGLE_HIGH_EFFORT_MIN_OUTPUT_TOKENS,
  GOOGLE_REASONING_EFFORT_BUDGET,
} from './reasoning-budget.js'
import { googleJsonSchemaProfile } from './json-schema.js'
import { GOOGLE_SAFETY_CATEGORIES, GOOGLE_SAFETY_THRESHOLDS } from './safety-settings.js'
import {
  countWebSearchQueries,
  normalizeGroundingCitations,
  readSearchEntryPoint,
} from './grounding.js'
import type { AnswerTextPart } from './grounding.js'
import {
  isSynthesizedToolCallId,
  reserveProviderToolCallIds,
  resolveToolCallId,
} from './tool-call-id.js'
import type {
  GeminiClientLike,
  GeminiGenerateConfig,
  GeminiContent,
  GeminiContentPart,
  GeminiResponseShape,
  GeminiUsageMetadataShape,
  GeminiCountTokensParams,
} from './client.js'
import { isGeminiCapacityError } from './flex-fallback.js'
import { classifyGoogleError } from './errors.js'
import { PLATFORM_SCHEDULER } from './platform-scheduler.js'
import { audioTokensReported } from './cost.js'
import { utf8ByteLength } from './utf8.js'
import {
  parseSignatureState,
  resolveSignatures,
  signatureEntry,
} from './thought-signatures.js'
import type { GoogleSignatureEntry } from './thought-signatures.js'

type GeminiGoogleSearchTool = { googleSearch: Record<string, never> }

type GeminiAllowedTool = GeminiGoogleSearchTool

type GeminiSafetySetting = {
  category: string
  threshold: string
}

type GeminiDispatchConfig = GeminiGenerateConfig & {
  cachedContent?: string
  httpOptions?: { timeout?: number }
  safetySettings?: GeminiSafetySetting[]
  tools?: GeminiGenerateConfig['tools']
}

const ALLOWED_GOOGLE_PROVIDER_OPTION_KEYS = new Set([
  'allowSchemaWithSearch',
  'cachedContent',
  'flexFallback',
  'httpOptions',
  'requireGrounding',
  'safetySettings',
  'tools',
])

const ALLOWED_GOOGLE_HTTP_OPTION_KEYS = new Set(['timeout'])

const RESERVED_GOOGLE_PROVIDER_OPTION_KEYS = new Set([
  'abortSignal',
  'imageConfig',
  'maxOutputTokens',
  'mediaResolution',
  'responseFormat',
  'responseMimeType',
  'responseModalities',
  'responseSchema',
  'responseJsonSchema',
  'serviceTier',
  'speechConfig',
  'stopSequences',
  'temperature',
  'thinkingConfig',
  'topK',
  'topP',
  '_responseJsonSchema',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEmptyPlainObject(value: unknown): value is Record<string, never> {
  return isPlainRecord(value) && Object.keys(value).length === 0
}

function badGoogleProviderOptions(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false })
}

function parseGoogleTool(tool: unknown, model: string): GeminiAllowedTool {
  if (!isPlainRecord(tool)) {
    throw badGoogleProviderOptions(
      `providerOptions.google.tools entries must be objects for model "${model}".`,
    )
  }

  const keys = Object.keys(tool)
  if (keys.length !== 1) {
    throw badGoogleProviderOptions(
      `providerOptions.google.tools entries must have exactly one supported tool key for model "${model}".`,
    )
  }

  const key = keys[0]
  switch (key) {
    case 'googleSearch': {
      if (!isEmptyPlainObject(tool['googleSearch'])) {
        throw badGoogleProviderOptions(
          `providerOptions.google.tools[].googleSearch must be an empty object for model "${model}".`,
        )
      }
      return { googleSearch: {} }
    }

    default:
      throw badGoogleProviderOptions(
        `providerOptions.google.tools[].${key} is not supported for model "${model}".`,
      )
  }
}

const SAFETY_CATEGORY_SET: ReadonlySet<string> = new Set(GOOGLE_SAFETY_CATEGORIES)
const SAFETY_THRESHOLD_SET: ReadonlySet<string> = new Set(GOOGLE_SAFETY_THRESHOLDS)

function parseGoogleSafetySetting(
  setting: unknown,
  index: number,
  model: string,
): GeminiSafetySetting {
  if (!isPlainRecord(setting)) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}] must be an object for model "${model}".`,
    )
  }

  const keys = Object.keys(setting)
  const unknownKeys = keys.filter((key) => key !== 'category' && key !== 'threshold')
  if (unknownKeys.length > 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}] contains unsupported keys [${unknownKeys.join(
        ', ',
      )}] for model "${model}". Allowed keys: category, threshold.`,
    )
  }

  if (
    typeof setting['category'] !== 'string' ||
    !SAFETY_CATEGORY_SET.has(setting['category'])
  ) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}].category must be one of ${GOOGLE_SAFETY_CATEGORIES.join(', ')} for model "${model}".`,
    )
  }

  if (
    typeof setting['threshold'] !== 'string' ||
    !SAFETY_THRESHOLD_SET.has(setting['threshold'])
  ) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}].threshold must be one of ${GOOGLE_SAFETY_THRESHOLDS.join(', ')} for model "${model}".`,
    )
  }

  return {
    category: setting['category'],
    threshold: setting['threshold'],
  }
}

type MappedGoogleProviderOptions = Partial<GeminiDispatchConfig> & {
  /**
   * The tool kinds the named cache holds, when the host passed a handle that
   * records them (`{ cacheName, toolKinds }`). Absent for a bare cache name:
   * what the cache holds is then unknown.
   */
  cachedToolKinds?: readonly string[]
  flexFallback?: boolean
  /** Effective `requireGrounding`: the explicit value, else on when the host opted into schema + search. */
  requireGrounding?: boolean
}

/** The JSON type of a value, for an error message that names what was received. */
function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

/**
 * Why a model that never had a measured schema + Search result cannot be sent
 * both. `structuredOutputWithTools: false` means a capture showed Search
 * missing and the host may opt in per call; absent means nothing was measured,
 * so there is no behaviour to opt into.
 */
function noSchemaWithSearchEvidence(model: string): string {
  return `Structured output with googleSearch is not supported for model "${model}": no live capture shows Search running when a response schema is attached to this model (the captures cover Gemini 3.x only), so there is no measured behaviour to opt into and providerOptions.google.allowSchemaWithSearch does not apply. Make two calls instead: grounded research without a schema, then structured synthesis (the two-call recipe in docs/grounded-structured.md).`
}

function mapGoogleProviderOptions({
  googleOpts,
  model,
  structuredOutputRequested,
  descriptorGrounding,
  descriptorCaching,
  structuredOutputWithTools,
}: {
  googleOpts: unknown
  model: string
  structuredOutputRequested: boolean
  descriptorGrounding: boolean | undefined
  descriptorCaching: boolean
  structuredOutputWithTools: boolean | undefined
}): MappedGoogleProviderOptions {
  if (googleOpts === undefined) {
    return {}
  }

  if (!isPlainRecord(googleOpts)) {
    throw badGoogleProviderOptions(
      `providerOptions.google must be an object for model "${model}".`,
    )
  }

  const reservedKeys = Object.keys(googleOpts).filter((key) =>
    RESERVED_GOOGLE_PROVIDER_OPTION_KEYS.has(key),
  )
  if (reservedKeys.length > 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google reserves keys [${reservedKeys.join(
        ', ',
      )}] for typed model config on "${model}".`,
    )
  }

  const unknownKeys = Object.keys(googleOpts).filter(
    (key) => !ALLOWED_GOOGLE_PROVIDER_OPTION_KEYS.has(key),
  )
  if (unknownKeys.length > 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google contains unsupported keys [${unknownKeys.join(
        ', ',
      )}] for model "${model}". Allowed keys: allowSchemaWithSearch, cachedContent, flexFallback, httpOptions, requireGrounding, safetySettings, tools.`,
    )
  }

  const mapped: MappedGoogleProviderOptions = {}

  if (googleOpts['cachedContent'] !== undefined) {
    if (!descriptorCaching) {
      throw badGoogleProviderOptions(
        `providerOptions.google.cachedContent is not supported for model "${model}": the model has no explicit-caching capability.`,
      )
    }
    const cached = googleOpts['cachedContent']
    if (typeof cached === 'string' && cached.length > 0) {
      mapped.cachedContent = cached
    } else if (isPlainRecord(cached)) {
      const extraKeys = Object.keys(cached).filter(
        (key) => key !== 'cacheName' && key !== 'toolKinds',
      )
      const cacheName = cached['cacheName']
      const toolKinds = cached['toolKinds']
      if (
        extraKeys.length > 0 ||
        typeof cacheName !== 'string' ||
        cacheName.length === 0 ||
        (toolKinds !== undefined &&
          (!Array.isArray(toolKinds) ||
            !toolKinds.every((kind) => typeof kind === 'string')))
      ) {
        throw badGoogleProviderOptions(
          `providerOptions.google.cachedContent must be a non-empty cache name, or { cacheName: non-empty string, toolKinds?: string[] } and nothing else (pass handle.cacheName and handle.toolKinds, not the whole handle), for model "${model}".`,
        )
      }
      mapped.cachedContent = cacheName
      if (toolKinds !== undefined) mapped.cachedToolKinds = toolKinds
    } else {
      throw badGoogleProviderOptions(
        `providerOptions.google.cachedContent must be a non-empty cache name, or { cacheName: non-empty string, toolKinds?: string[] }, for model "${model}".`,
      )
    }
  }

  if (googleOpts['flexFallback'] !== undefined) {
    if (typeof googleOpts['flexFallback'] !== 'boolean') {
      throw badGoogleProviderOptions(
        `providerOptions.google.flexFallback must be a boolean for model "${model}".`,
      )
    }
    mapped.flexFallback = googleOpts['flexFallback']
  }

  if (googleOpts['httpOptions'] !== undefined) {
    if (!isPlainRecord(googleOpts['httpOptions'])) {
      throw badGoogleProviderOptions(
        `providerOptions.google.httpOptions must be an object for model "${model}".`,
      )
    }

    const unknownHttpOptionKeys = Object.keys(googleOpts['httpOptions']).filter(
      (key) => !ALLOWED_GOOGLE_HTTP_OPTION_KEYS.has(key),
    )
    if (unknownHttpOptionKeys.length > 0) {
      throw badGoogleProviderOptions(
        `providerOptions.google.httpOptions contains unsupported keys [${unknownHttpOptionKeys.join(
          ', ',
        )}] for model "${model}". Allowed keys: timeout.`,
      )
    }

    const timeout = googleOpts['httpOptions']['timeout']
    if (timeout !== undefined) {
      if (
        typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout <= 0 ||
        timeout > MAX_TIMER_MS
      ) {
        throw badGoogleProviderOptions(
          `providerOptions.google.httpOptions.timeout must be a positive integer of at most ${MAX_TIMER_MS} ms (the longest delay a Node timer holds; a larger one aborts the call after 1 ms) for model "${model}".`,
        )
      }
      mapped.httpOptions = { timeout }
    } else {
      mapped.httpOptions = {}
    }
  }

  if (googleOpts['safetySettings'] !== undefined) {
    if (!Array.isArray(googleOpts['safetySettings'])) {
      throw badGoogleProviderOptions(
        `providerOptions.google.safetySettings must be an array for model "${model}".`,
      )
    }

    mapped.safetySettings = googleOpts['safetySettings'].map((setting, index) =>
      parseGoogleSafetySetting(setting, index, model),
    )
  }

  const allowSchemaWithSearch = googleOpts['allowSchemaWithSearch']
  if (allowSchemaWithSearch !== undefined && typeof allowSchemaWithSearch !== 'boolean') {
    throw badGoogleProviderOptions(
      `providerOptions.google.allowSchemaWithSearch must be a boolean for model "${model}", received ${describeType(allowSchemaWithSearch)}.`,
    )
  }
  const requireGrounding = googleOpts['requireGrounding']
  if (requireGrounding !== undefined && typeof requireGrounding !== 'boolean') {
    throw badGoogleProviderOptions(
      `providerOptions.google.requireGrounding must be a boolean for model "${model}", received ${describeType(requireGrounding)}.`,
    )
  }

  if (googleOpts['tools'] !== undefined) {
    if (!Array.isArray(googleOpts['tools'])) {
      throw badGoogleProviderOptions(
        `providerOptions.google.tools must be an array for model "${model}".`,
      )
    }

    const tools = googleOpts['tools'].map((tool) => parseGoogleTool(tool, model))
    if (descriptorGrounding !== true) {
      throw badGoogleProviderOptions(
        `providerOptions.google.tools is not supported for model "${model}".`,
      )
    }

    if (structuredOutputRequested && structuredOutputWithTools !== true) {
      if (structuredOutputWithTools === undefined) {
        throw badGoogleProviderOptions(noSchemaWithSearchEvidence(model))
      }
      if (allowSchemaWithSearch !== true) {
        throw badGoogleProviderOptions(
          `Structured output with googleSearch is not enabled for model "${model}": the provider accepts the request but Search does not reliably run when a response schema is attached. Make two calls instead: grounded research without a schema, then structured synthesis (the two-call recipe in docs/grounded-structured.md). To send both in one call anyway, set providerOptions.google.allowSchemaWithSearch: true; the call then fails unless the response proves Search ran (requireGrounding), and that failure is not retryable because the same call keeps missing.`,
        )
      }
    }

    mapped.tools = tools
  }

  const searchSent = mapped.tools?.some((tool) => 'googleSearch' in tool) === true
  if (allowSchemaWithSearch === true) {
    if (descriptorGrounding !== true) {
      throw badGoogleProviderOptions(
        `providerOptions.google.allowSchemaWithSearch is not supported for model "${model}": the model does not support grounding.`,
      )
    }
    if (!searchSent || !structuredOutputRequested) {
      throw badGoogleProviderOptions(
        `providerOptions.google.allowSchemaWithSearch requires both providerOptions.google.tools: [{ googleSearch: {} }] and output.jsonSchema for model "${model}".`,
      )
    }
    if (structuredOutputWithTools === undefined) {
      throw badGoogleProviderOptions(noSchemaWithSearchEvidence(model))
    }
  }

  if (requireGrounding === true && !searchSent) {
    throw badGoogleProviderOptions(
      `providerOptions.google.requireGrounding requires providerOptions.google.tools: [{ googleSearch: {} }] for model "${model}".`,
    )
  }
  const effectiveRequireGrounding = requireGrounding ?? allowSchemaWithSearch === true
  if (effectiveRequireGrounding) mapped.requireGrounding = true

  return mapped
}

function assertSamplingAllowed(
  config: GeminiDispatchConfig,
  model: string,
  sampling: string | undefined,
): void {
  if (sampling !== 'fixed') {
    return
  }

  const offendingSampling: string[] = []
  if ('temperature' in config) {
    offendingSampling.push('temperature')
  }
  if ('topP' in config) {
    offendingSampling.push('topP')
  }
  if ('topK' in config) {
    offendingSampling.push('topK')
  }

  if (offendingSampling.length > 0) {
    throw new LlmError(
      `Sampling parameters [${offendingSampling.join(', ')}] are not supported for model "${model}" (fixed sampling).`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

// ---------------------------------------------------------------------------
// FinishReason mapping (Gemini SDK enum → our FinishReason)
// ---------------------------------------------------------------------------

/**
 * Largest request Google accepts without the Files API: "Always use the Files
 * API when the total request size (including the files, text prompt, system
 * instructions, etc.) is larger than 100 MB. For PDF files, the limit is 50
 * MB." (ai.google.dev/gemini-api/docs/files and /file-input-methods, both
 * dated 2026-09-23, read 2026-10-03). MB is read as MiB, the looser reading,
 * so the check never rejects what Google would accept.
 */
const MAX_INLINE_REQUEST_BYTES = 100 * 1024 * 1024
const MAX_INLINE_PDF_BYTES = 50 * 1024 * 1024
/** The one media type the PDF cap applies to, matched as admission matches it. */
const PDF_MEDIA_TYPES: readonly string[] = ['application/pdf']

/**
 * Rejects, before dispatch, a request whose inline data and text certainly
 * exceed Google's request limit. The size counted is a lower bound of the
 * request body: base64 characters of inline media, UTF-8 bytes of text and the
 * system instruction.
 */
function assertInlinePayloadWithinLimits(
  contents: readonly GeminiContent[],
  system: string | undefined,
): void {
  let total = system === undefined ? 0 : utf8ByteLength(system)
  contents.forEach((content, mi) => {
    content.parts.forEach((part, pi) => {
      if ('text' in part) total += utf8ByteLength(part.text)
      if (!('inlineData' in part)) return
      const { mimeType, data } = part.inlineData
      total += data.length
      if (isMediaTypeAdmitted(mimeType, PDF_MEDIA_TYPES)) {
        const decoded = Math.floor((data.length * 3) / 4)
        if (decoded > MAX_INLINE_PDF_BYTES) {
          throw new LlmError(
            `messages[${mi}].parts[${pi}] is an inline PDF of about ${decoded} bytes, over Google's 50 MB inline PDF limit. Upload it with GoogleFileStore and send a file-uri part.`,
            {
              kind: 'bad_request',
              retryable: false,
              provider: 'google',
              issues: [
                {
                  path: `messages[${mi}].parts[${pi}]`,
                  message: 'inline PDF over 50 MB',
                },
              ],
            },
          )
        }
      }
    })
  })
  if (total > MAX_INLINE_REQUEST_BYTES) {
    throw new LlmError(
      `The request carries at least ${total} bytes of inline data and text, over Google's 100 MB request limit. Upload large media with GoogleFileStore and send file-uri parts.`,
      {
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
        issues: [{ path: 'messages', message: 'request over 100 MB' }],
      },
    )
  }
}

/** Candidate fields copied to `providerMetadata.google.candidate` when present. */
const CANDIDATE_METADATA_KEYS = [
  'finishReason',
  'finishMessage',
  'safetyRatings',
  'citationMetadata',
  'urlContextMetadata',
] as const

/** Longest `finishMessage` copied into a row or an error (characters). */
const MAX_FINISH_MESSAGE_CHARS = 512
/** Most entries kept from any array in copied candidate metadata. */
const MAX_METADATA_ARRAY = 50
/** Longest string kept inside copied candidate metadata (characters). */
const MAX_METADATA_STRING = 2048
/** Deepest nesting copied from candidate metadata. */
const MAX_METADATA_DEPTH = 8
/** Most safety ratings listed in an error message. */
const MAX_RATINGS_IN_MESSAGE = 12

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * A bounded copy of provider metadata for a row: strings are cut at
 * `MAX_METADATA_STRING`, arrays at `MAX_METADATA_ARRAY` entries, nesting at
 * `MAX_METADATA_DEPTH`. `state.truncated` says whether anything was cut.
 * `providerMetadata` is persisted on every row, and these fields can carry
 * model text (a malformed function call's `finishMessage`) or long source lists.
 */
function boundMetadata(
  value: unknown,
  state: { truncated: boolean },
  depth = 0,
): JsonValue {
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_STRING) state.truncated = true
    return truncateText(value, MAX_METADATA_STRING)
  }
  if (value === null || typeof value !== 'object') return value as JsonValue
  if (depth >= MAX_METADATA_DEPTH) {
    state.truncated = true
    return null
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY) state.truncated = true
    return value
      .slice(0, MAX_METADATA_ARRAY)
      .map((item) => boundMetadata(item, state, depth + 1))
  }
  const out: { [k: string]: JsonValue } = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = boundMetadata(item, state, depth + 1)
  }
  return out
}

/**
 * `category=probability` per safety rating (`(blocked)` when the rating blocked
 * the response), bounded, for an error message: which category refused the
 * call is the evidence a host needs from a filtered empty response.
 */
function describeSafetyRatings(ratings: unknown): string {
  if (!Array.isArray(ratings) || ratings.length === 0) return ''
  const parts = ratings.slice(0, MAX_RATINGS_IN_MESSAGE).flatMap((rating) => {
    if (typeof rating !== 'object' || rating === null) return []
    const { category, probability, blocked } = rating as Record<string, unknown>
    if (typeof category !== 'string') return []
    return [
      `${truncateText(category, 80)}=${
        typeof probability === 'string' ? truncateText(probability, 40) : 'unknown'
      }${blocked === true ? ' (blocked)' : ''}`,
    ]
  })
  if (parts.length === 0) return ''
  const more =
    ratings.length > MAX_RATINGS_IN_MESSAGE
      ? ` and ${ratings.length - MAX_RATINGS_IN_MESSAGE} more`
      : ''
  return `${parts.join(', ')}${more}`
}

function mapFinishReason(raw: string | undefined): FinishReason | undefined {
  if (raw === undefined) return undefined
  switch (raw) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return 'content_filter'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// mediaResolution mapping (normalized hint → Gemini PartMediaResolutionLevel)
// ---------------------------------------------------------------------------

/**
 * Map our normalized cross-provider `mediaResolution` hint to the Gemini
 * `PartMediaResolutionLevel` string-enum value emitted on `Part.mediaResolution`.
 */
function mapMediaResolution(
  res: 'low' | 'medium' | 'high',
): 'MEDIA_RESOLUTION_LOW' | 'MEDIA_RESOLUTION_MEDIUM' | 'MEDIA_RESOLUTION_HIGH' {
  switch (res) {
    case 'low':
      return 'MEDIA_RESOLUTION_LOW'
    case 'medium':
      return 'MEDIA_RESOLUTION_MEDIUM'
    case 'high':
      return 'MEDIA_RESOLUTION_HIGH'
    default:
      return assertNever(res)
  }
}

// ---------------------------------------------------------------------------
// Usage mapping — #1 correctness rule
// ---------------------------------------------------------------------------

/**
 * Map Gemini usageMetadata to our Usage type.
 *
 * **GROSS convention enforced here:**
 * - outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)
 *   → thinkingTokens ⊆ outputTokens so cost math doesn't double-count.
 * - inputTokens = promptTokenCount (cachedContentTokenCount is already a
 *   subset of promptTokenCount → cachedInputTokens = cachedContentTokenCount).
 */
function mapUsage(meta: GeminiUsageMetadataShape | undefined): Usage {
  const promptTokenCount = meta?.promptTokenCount ?? 0
  const candidatesTokenCount = meta?.candidatesTokenCount ?? 0
  const cachedContentTokenCount = meta?.cachedContentTokenCount
  const thoughtsTokenCount = meta?.thoughtsTokenCount
  const toolUsePromptTokenCount = meta?.toolUsePromptTokenCount

  // #1 RULE: outputTokens = candidates + thoughts (GROSS; thinking ⊆ output)
  const outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0)
  const inputTokens = promptTokenCount
  const totalTokens = meta?.totalTokenCount

  // Canonical details keys: input, cached, output.
  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedContentTokenCount !== undefined ? { cached: cachedContentTokenCount } : {}),
    ...(thoughtsTokenCount !== undefined ? { thinking: thoughtsTokenCount } : {}),
    // Tokens of Search results fed back to the model. They sit in
    // `totalTokenCount` but outside `promptTokenCount`. Google's pricing page
    // (read in the 2026-10 audit) says retrieved search results are not charged
    // as input tokens, so they are recorded and not priced; no live billing
    // reconciliation has confirmed it, so the total mismatch still marks the
    // cost `estimated`.
    ...(toolUsePromptTokenCount !== undefined
      ? { tool_use_prompt: toolUsePromptTokenCount }
      : {}),
  }

  // Per-modality prompt tokens, under `input_<modality>` (the whole prompt, cached
  // part included) and `cached_<modality>` (the cached part): the pricing source
  // bills audio apart from text on the models that price it apart. A modality
  // listed twice sums.
  let cachedSplitTokens: number | undefined
  for (const [prefix, entries] of [
    ['input', meta?.promptTokensDetails],
    ['cached', meta?.cacheTokensDetails],
  ] as const) {
    if (!Array.isArray(entries)) continue
    if (prefix === 'cached') cachedSplitTokens = 0
    for (const entry of entries as readonly unknown[]) {
      // Malformed provider output (a null entry, a missing field) is skipped.
      if (typeof entry !== 'object' || entry === null) continue
      const { modality, tokenCount: count } = entry as {
        modality?: unknown
        tokenCount?: unknown
      }
      if (
        typeof modality !== 'string' ||
        modality === '' ||
        typeof count !== 'number' ||
        !Number.isFinite(count) ||
        count < 0
      ) {
        continue
      }
      const key = `${prefix}_${modality.toLowerCase()}`
      details[key] = (details[key] ?? 0) + count
      if (prefix === 'cached') cachedSplitTokens = (cachedSplitTokens ?? 0) + count
    }
  }
  // A cache split that lists no audio and covers every cached token proves the
  // cached audio is zero (a text cache beside audio in the new part of the prompt),
  // so the pricing source need not treat it as unknown. A split that covers fewer
  // tokens than were cached leaves the remainder, and so the audio share, unknown.
  if (
    cachedSplitTokens !== undefined &&
    cachedContentTokenCount !== undefined &&
    cachedContentTokenCount > 0 &&
    cachedSplitTokens >= cachedContentTokenCount &&
    details['cached_audio'] === undefined
  ) {
    details['cached_audio'] = 0
  }

  // Raw: the full usageMetadata object verbatim (as JsonValue).
  const raw: JsonValue =
    meta !== undefined ? (meta as unknown as { [k: string]: JsonValue }) : null

  const usage: Usage = {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedContentTokenCount !== undefined
      ? { cachedInputTokens: cachedContentTokenCount }
      : {}),
    ...(thoughtsTokenCount !== undefined ? { thinkingTokens: thoughtsTokenCount } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }

  return usage
}

// ---------------------------------------------------------------------------
// Message → Gemini contents mapping (shared by run() and countTokens())
// ---------------------------------------------------------------------------

/**
 * Map a single {@link Part} to its Gemini SDK equivalent.
 *
 * - `text`          → `{ text }`
 * - `inline-media`  → `{ inlineData: { mimeType, data } }` + optional `mediaResolution`
 * - `file-uri`      → `{ fileData: { mimeType, fileUri } }` + optional `mediaResolution`
 * - `file-ref`      → rejected (`bad_request`) — Gemini Files uses URIs, not bare ids
 *
 * `mediaResolution` IS supported as a per-part field by the Gemini SDK
 * (`Part.mediaResolution`).  The normalised value is mapped to the
 * `PartMediaResolutionLevel` string enum before emission.
 */
function mapGoogleToolChoice(choice: ToolChoice): {
  mode: 'AUTO' | 'ANY' | 'NONE'
  allowedFunctionNames?: string[]
} {
  if (choice === 'auto') return { mode: 'AUTO' }
  if (choice === 'required') return { mode: 'ANY' }
  if (choice === 'none') return { mode: 'NONE' }
  return { mode: 'ANY', allowedFunctionNames: [choice.name] }
}

/**
 * Gemini's `functionResponse.response` must be a JSON object. An error result
 * is `{ error }`; a non-object result is wrapped as `{ output }`.
 */
function toFunctionResponseObject(p: {
  result: JsonValue
  isError?: boolean
}): Record<string, unknown> {
  if (p.isError === true) return { error: p.result }
  if (typeof p.result === 'object' && p.result !== null && !Array.isArray(p.result)) {
    return p.result
  }
  return { output: p.result }
}

function mapPart(p: Part, signature: string | undefined): GeminiContentPart {
  switch (p.kind) {
    case 'text':
      return {
        text: p.text,
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      }

    case 'inline-media': {
      return {
        inlineData: {
          mimeType: p.mimeType,
          data: p.data,
        },
        ...(p.mediaResolution !== undefined
          ? { mediaResolution: { level: mapMediaResolution(p.mediaResolution) } }
          : {}),
      }
    }

    case 'file-uri': {
      return {
        fileData: {
          mimeType: p.mimeType,
          fileUri: p.uri,
        },
        ...(p.mediaResolution !== undefined
          ? { mediaResolution: { level: mapMediaResolution(p.mediaResolution) } }
          : {}),
      }
    }

    case 'file-ref':
      throw new LlmError(
        'Google Gemini expects FileUriPart with a Files API uri; got file-ref (provider file id). Upload via GoogleFileStore and pass the returned uri.',
        { kind: 'bad_request', retryable: false, provider: 'google' },
      )

    case 'tool-call':
      return {
        functionCall: {
          // A synthesized id never reached Gemini; sending it would only be noise.
          ...(isSynthesizedToolCallId(p.toolCallId) ? {} : { id: p.toolCallId }),
          name: p.toolName,
          args: p.args,
        },
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      }

    case 'tool-result':
      return {
        functionResponse: {
          ...(isSynthesizedToolCallId(p.toolCallId) ? {} : { id: p.toolCallId }),
          name: p.toolName,
          response: toFunctionResponseObject(p),
        },
      }

    default:
      return assertNever(p)
  }
}

/**
 * Map engine {@link Message}s to Gemini SDK `contents`.
 *
 * Shared by `run()` (generation) and `countTokens()` (token counting) so both
 * code paths map messages identically — a divergence here would make token
 * counts unrepresentative of the actual generation call.
 */
export function mapMessagesToGeminiContents(
  messages: Message[],
  signatures?: ReadonlyMap<string, string>,
): GeminiContent[] {
  return messages.map((msg, mi) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: msg.parts.map((part, pi) => mapPart(part, signatures?.get(`${mi}:${pi}`))),
  }))
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface GeminiAdapterOptions {
  /**
   * Inject a pre-built client (real or fake).
   * When omitted, `buildGoogleClient` is called with `ctx.auth` at call time,
   * inside the classified try/catch so any construction failure is wrapped
   * as a typed `LlmError`.
   */
  client?: GeminiClientLike
}

// ---------------------------------------------------------------------------
// geminiAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Gemini provider adapter.
 *
 * @param opts.client - Optional pre-built client (e.g. for testing).
 */
export function geminiAdapter(opts?: GeminiAdapterOptions): ProviderAdapter {
  return geminiAdapterWithClientFactory(opts?.client, buildGoogleClient)
}

/**
 * The adapter with its client factory replaced: the seam a test uses to make
 * client construction fail without the real SDK. Not exported from the package
 * index, so it is in no shipped type.
 *
 * @internal
 */
export function geminiAdapterWithClientFactory(
  injectedClient: GeminiClientLike | undefined,
  buildClient: (auth: AuthMaterial) => GeminiClientLike | Promise<GeminiClientLike>,
): ProviderAdapter {
  return {
    id: 'google',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      if (req.provider !== 'google') {
        throw new LlmError(
          `geminiAdapter received a request for provider "${req.provider}", expected "google".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const warnings: Warning[] = []
      const model = req.model
      const descriptor = req.modelDescriptor
      assertModelMatchesDescriptor(req, descriptor, 'google')
      assertInputMimeTypesAdmitted(req.messages, descriptor, 'google')
      const signsHistory = descriptor.capabilities?.providerState === true
      if (req.transientProviderState !== undefined && !signsHistory) {
        throw new LlmError(`Model "${model}" does not admit transientProviderState.`, {
          kind: 'bad_request',
          retryable: false,
        })
      }

      // ------------------------------------------------------------------
      // 1. Map messages → contents. Gemini 3.x replays each turn's thought
      //    signatures from the overlay in transientProviderState, checked
      //    against the host's own messages (no copy of the history is kept).
      // ------------------------------------------------------------------

      const resolved = signsHistory
        ? resolveSignatures(
            parseSignatureState(req.transientProviderState),
            req.messages,
            model,
          )
        : undefined
      // Stale text entries were dropped; the verified ones are carried forward.
      const incomingSignatures: GoogleSignatureEntry[] = resolved?.kept ?? []
      if (resolved !== undefined && resolved.dropped.length > 0) {
        warnings.push({
          type: 'other',
          message: `google: dropped ${resolved.dropped.length} stale text signature(s) from transientProviderState (${resolved.dropped.join('; ')}); Google treats text signatures as optional, so nothing required was lost.`,
        })
      }
      const contents: GeminiContent[] = mapMessagesToGeminiContents(
        req.messages,
        resolved?.bySlot,
      )
      // An empty system string adds no instruction, so it is absent everywhere
      // (here, the `cachedContent` conflict check and `countTokens`).
      const system =
        req.system !== undefined && req.system !== '' ? req.system : undefined
      assertInlinePayloadWithinLimits(contents, system)

      // ------------------------------------------------------------------
      // 2. Build GenerateContentConfig
      // ------------------------------------------------------------------
      const genConfig = req.config
      const config: GeminiDispatchConfig = {}

      // System instruction
      if (system !== undefined) {
        config.systemInstruction = { parts: [{ text: system }] }
      }

      // Basic generation parameters (only include when defined)
      if (genConfig.temperature !== undefined) {
        config.temperature = genConfig.temperature
      }
      if (genConfig.topP !== undefined) {
        config.topP = genConfig.topP
      }
      if (genConfig.topK !== undefined) {
        config.topK = genConfig.topK
      }
      if (genConfig.maxOutputTokens !== undefined) {
        config.maxOutputTokens = genConfig.maxOutputTokens
      }
      if (genConfig.stopSequences !== undefined) {
        config.stopSequences = genConfig.stopSequences
      }

      // Service tier (FLEX or STANDARD)
      // Real SDK: GenerateContentConfig.serviceTier = ServiceTier enum ("flex"|"standard")
      const explicit = (genConfig as { serviceTier?: 'flex' | 'standard' }).serviceTier
      const supported = descriptor.capabilities?.serviceTiers
      if (explicit !== undefined) {
        // caller explicitly chose a tier — reject if the model can't honour it
        if (supported === undefined || !supported.includes(explicit)) {
          throw new LlmError(
            `serviceTier "${explicit}" is not supported for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }
        config.serviceTier = explicit
      }

      // ------------------------------------------------------------------
      // 3. Reasoning → thinkingConfig
      // ------------------------------------------------------------------
      const reasoning = genConfig.reasoning
      if (reasoning !== undefined) {
        const reasoningApi = descriptor.capabilities?.reasoningApi

        if (reasoning.effort === 'max') {
          throw new LlmError(
            `reasoning.effort "max" is not supported for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }

        if (reasoning.effort !== undefined && reasoning.budgetTokens !== undefined) {
          throw new LlmError(
            `Provide either reasoning.effort or reasoning.budgetTokens, not both, for model "${model}".`,
            { kind: 'bad_request', retryable: false },
          )
        }

        if (reasoningApi === 'budget') {
          // gemini-2.5* → thinkingBudget. `xhigh` is not a Gemini thinking
          // budget — reject rather than invent a token count.
          if (
            reasoning.effort === 'none' &&
            descriptor.capabilities?.admittedReasoningEfforts?.includes('none') !== true
          ) {
            throw new LlmError(
              `reasoning.effort "none" is not supported for model "${model}".`,
              { kind: 'bad_request', retryable: false },
            )
          }
          if (reasoning.effort === 'xhigh') {
            throw new LlmError(
              `reasoning.effort "xhigh" is not supported for model "${model}".`,
              { kind: 'bad_request', retryable: false },
            )
          }
          const budget =
            reasoning.budgetTokens !== undefined
              ? reasoning.budgetTokens
              : reasoning.effort !== undefined
                ? GOOGLE_REASONING_EFFORT_BUDGET[reasoning.effort]
                : undefined

          // Google says actual thinking can under- or overflow the budget, so a
          // budget at or above the output cap is a risk, not an invalid request.
          if (
            budget !== undefined &&
            budget > 0 &&
            genConfig.maxOutputTokens !== undefined &&
            budget >= genConfig.maxOutputTokens
          ) {
            warnings.push({
              type: 'other',
              message: `google: thinkingBudget (${budget}) is not below maxOutputTokens (${genConfig.maxOutputTokens}); thinking may consume the whole cap and leave no answer. Raise maxOutputTokens or lower the reasoning budget.`,
            })
          }

          config.thinkingConfig = {
            ...(budget !== undefined ? { thinkingBudget: budget } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }
        } else if (reasoningApi === 'level') {
          // gemini-3.* → thinkingLevel
          if (reasoning.budgetTokens !== undefined) {
            throw new LlmError(
              `reasoning.budgetTokens is not supported for model "${model}" (it uses thinkingLevel, not thinkingBudget); use reasoning.effort instead.`,
              { kind: 'bad_request', retryable: false },
            )
          }

          // Real SDK ThinkingLevel enum: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL".
          // `none` maps to MINIMAL only when the descriptor admits it.
          const admitted = descriptor.capabilities?.admittedReasoningEfforts
          const admitsNone = admitted?.includes('none') === true
          let thinkingLevel: string | undefined
          if (reasoning.effort !== undefined) {
            switch (reasoning.effort) {
              case 'none':
                if (!admitsNone) {
                  throw new LlmError(
                    `reasoning.effort "none" is not supported for model "${model}"; thinkingLevel MINIMAL is not emitted.`,
                    { kind: 'bad_request', retryable: false },
                  )
                }
                thinkingLevel = 'MINIMAL'
                break
              case 'low':
                thinkingLevel = 'LOW'
                break
              case 'medium':
                thinkingLevel = 'MEDIUM'
                break
              case 'high':
                thinkingLevel = 'HIGH'
                break
              case 'xhigh':
                throw new LlmError(
                  `reasoning.effort "${reasoning.effort}" is not supported for model "${model}".`,
                  { kind: 'bad_request', retryable: false },
                )
              default:
                assertNever(reasoning.effort)
            }
          }

          // A level model has no budget to compare with the cap, so the rule is
          // the measured one: at `high`, thinking reached 4,000+ tokens in about 10%
          // of calls (docs/thinking-token-distribution.md). A risk, not a rejection.
          if (
            thinkingLevel === 'HIGH' &&
            genConfig.maxOutputTokens !== undefined &&
            genConfig.maxOutputTokens < GOOGLE_HIGH_EFFORT_MIN_OUTPUT_TOKENS
          ) {
            warnings.push({
              type: 'other',
              message: `google: reasoning.effort "high" can spend several thousand thinking tokens (measured up to 8,859) and maxOutputTokens is ${genConfig.maxOutputTokens}, below ${GOOGLE_HIGH_EFFORT_MIN_OUTPUT_TOKENS}; thinking may consume the whole cap and leave no answer. Raise maxOutputTokens or lower the effort.`,
            })
          }

          config.thinkingConfig = {
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            ...(reasoning.includeThoughts === true ? { includeThoughts: true } : {}),
          }
        } else {
          throw new LlmError(
            `Model "${model}" does not support reasoning/thinkingConfig.`,
            { kind: 'bad_request', retryable: false },
          )
        }
      }

      // ------------------------------------------------------------------
      // 4. Structured output → responseMimeType + responseJsonSchema
      // ------------------------------------------------------------------
      const structuredOutputRequested = req.outputJsonSchema !== undefined
      if (structuredOutputRequested) {
        // This adapter has one structured-output path, the native one; a schema
        // for a model without it would be dropped, so it is rejected.
        if (descriptor.capabilities?.nativeStructuredOutput === false) {
          throw new LlmError(
            `output.jsonSchema is not supported for model "${model}": the model has no native structured output and the Google adapter has no other path.`,
            {
              kind: 'bad_request',
              retryable: false,
              provider: 'google',
              issues: [
                {
                  path: 'output.jsonSchema',
                  message: 'model has no native structured output',
                },
              ],
            },
          )
        }
        // Standard JSON Schema, verbatim and in the host's key order. A
        // keyword Google would silently ignore is rejected here, not sent.
        assertJsonSchemaProfile(
          req.outputJsonSchema as JsonValue,
          'output.jsonSchema',
          googleJsonSchemaProfile(descriptor.model),
        )
        config.responseMimeType = 'application/json'
        config.responseJsonSchema = req.outputJsonSchema
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.google → explicit allowlisted mapping
      // ------------------------------------------------------------------
      const googleProviderConfig = mapGoogleProviderOptions({
        googleOpts: genConfig.providerOptions?.['google'],
        model,
        structuredOutputRequested,
        descriptorGrounding: descriptor.capabilities?.grounding,
        descriptorCaching: descriptor.capabilities?.caching !== undefined,
        structuredOutputWithTools: descriptor.capabilities?.structuredOutputWithTools,
      })
      // Search facts, normalised across providers (ADR-035): `web_search_requested`
      // is 1 when Search was asked for; `web_search_calls` is the number of
      // queries the response reports (occurrences, not unique strings), absent
      // when the response does not say. The pricing source reads both, because
      // it sees only `(model, usage, tier)`.
      //
      // Search was asked for when the request sent `googleSearch`, or when the
      // handle behind `cachedContent` records that its cache holds the tool (the
      // request then carries no tool). When the request declares no search (a
      // bare cache name says nothing about what the cache holds), grounding
      // metadata in the response is the evidence: queries observed mean the fee
      // was incurred, so it is priced from them, and the cost is never exact.
      const googleSearchSent =
        googleProviderConfig.tools?.some((tool) => 'googleSearch' in tool) === true
      const searchDeclared =
        googleSearchSent ||
        googleProviderConfig.cachedToolKinds?.includes('googleSearch') === true
      const requireGrounding = googleProviderConfig.requireGrounding === true
      // Audio in the prompt is billed at its own rate on some models, from the
      // per-modality counts the response reports; `audio_input_requested` lets the
      // pricing source tell a response that omits them from a request without audio.
      const audioRequested = req.messages.some((message) =>
        message.parts.some(
          (part) =>
            (part.kind === 'inline-media' || part.kind === 'file-uri') &&
            part.mimeType.toLowerCase().startsWith('audio/'),
        ),
      )
      const usageFor = (
        meta: GeminiUsageMetadataShape | undefined,
        groundingMetadata?: unknown,
      ): Usage => {
        const mapped = mapUsage(meta)
        if (audioRequested) mapped.details['audio_input_requested'] = 1
        const queries = countWebSearchQueries(groundingMetadata)
        if (searchDeclared) {
          mapped.details['web_search_requested'] = 1
          if (queries !== undefined) mapped.details['web_search_calls'] = queries
        } else if (groundingMetadata !== undefined) {
          // Undeclared Search with grounding metadata: queries observed price the
          // fee; none observed leaves the count unknown (estimated, tools lane 0).
          mapped.details['web_search_requested'] = 1
          if (queries !== undefined && queries > 0) {
            mapped.details['web_search_calls'] = queries
          }
        }
        return mapped
      }
      /** Warnings about a grounded call whose response does not show what Search did. */
      const groundingWarnings = (groundingMetadata: unknown): Warning[] => {
        if (!searchDeclared) {
          if (groundingMetadata === undefined) return []
          const queries = countWebSearchQueries(groundingMetadata)
          return [
            {
              type: 'other',
              message:
                queries !== undefined && queries > 0
                  ? `google: the response reports ${queries} search quer${queries === 1 ? 'y' : 'ies'} but the request did not declare googleSearch (a cachedContent cache can hold the tool); the Search fee was priced from the observed queries, and cost.confidence is "estimated" because the free allowance is unknowable per call.`
                  : 'google: the response carries groundingMetadata but the request did not declare googleSearch and the metadata names no query, so the number of searches is unknown; grounding fees are not included in cost, so cost.confidence is "estimated".',
            },
          ]
        }
        if (groundingMetadata === undefined) {
          return [
            {
              type: 'other',
              message:
                'google: googleSearch was requested (sent, or held by the cache named in cachedContent) but the response carries no groundingMetadata, so Search may not have run, or may have run without being reported; grounding fees are not included in cost, so cost.confidence is "estimated".',
            },
          ]
        }
        if (countWebSearchQueries(groundingMetadata) === undefined) {
          return [
            {
              type: 'other',
              message:
                'google: groundingMetadata has no webSearchQueries, so the number of searches is unknown; grounding fees are not included in cost, so cost.confidence is "estimated".',
            },
          ]
        }
        return []
      }
      /** Warnings about an audio request whose response does not split the prompt by modality. */
      const modalityWarnings = (
        meta: GeminiUsageMetadataShape | undefined,
      ): Warning[] => {
        if (meta === undefined) return []
        const warnings: Warning[] = []
        const mapped = mapUsage(meta)
        if (audioRequested && !audioTokensReported(mapped)) {
          warnings.push({
            type: 'other',
            message:
              'google: the request carries audio but usageMetadata.promptTokensDetails reports no AUDIO tokens, so the audio input rate could not be applied; on a model that prices audio apart from text, cost.confidence is "estimated" and the amount can understate.',
          })
        }
        const hasSplit = Object.keys(mapped.details).some(
          (key) => key.startsWith('input_') || key.startsWith('cached_'),
        )
        if ((mapped.cachedInputTokens ?? 0) > 0 && !hasSplit) {
          warnings.push({
            type: 'other',
            message:
              'google: usageMetadata reports cached tokens with no per-modality split (promptTokensDetails and cacheTokensDetails are both absent), so audio in the cached content cannot be ruled out; on a model that prices audio apart from text, cost.confidence is "estimated" and the amount can understate.',
          })
        }
        return warnings
      }
      /** `usage` (and the grounding note) a failed-but-billed attempt carries. */
      const billedFailure = (
        meta: GeminiUsageMetadataShape | undefined,
        groundingMetadata?: unknown,
      ): { usage?: Usage; warnings?: Warning[] } => {
        if (meta === undefined) return {}
        const failureWarnings = [
          ...groundingWarnings(groundingMetadata),
          ...modalityWarnings(meta),
        ]
        return {
          usage: usageFor(meta, groundingMetadata),
          ...(failureWarnings.length > 0 ? { warnings: failureWarnings } : {}),
        }
      }

      if (googleProviderConfig.cachedContent !== undefined) {
        config.cachedContent = googleProviderConfig.cachedContent
      }
      if (googleProviderConfig.httpOptions !== undefined) {
        config.httpOptions = googleProviderConfig.httpOptions
        // The SDK arms its own timer from `httpOptions.timeout`. When the engine
        // arms its deadline at `timeoutMs`, a shorter SDK timer would end the call
        // first with a raw SDK abort instead of the engine's clean `timeout`.
        const sdkTimeout = googleProviderConfig.httpOptions.timeout
        if (
          sdkTimeout !== undefined &&
          genConfig.timeoutMs !== undefined &&
          sdkTimeout < genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
        ) {
          throw badGoogleProviderOptions(
            `providerOptions.google.httpOptions.timeout (${sdkTimeout} ms) must be at least timeoutMs + ${TRANSPORT_TIMEOUT_BUFFER_MS} ms (${
              genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
            } ms) for model "${model}": a shorter SDK timer would abort the call before the engine's own timeout and surface a raw SDK abort.`,
          )
        }
      }
      if (googleProviderConfig.safetySettings !== undefined) {
        config.safetySettings = googleProviderConfig.safetySettings
      }
      if (googleProviderConfig.tools !== undefined) {
        config.tools = googleProviderConfig.tools
      }

      if (req.tools !== undefined && req.tools.length > 0) {
        if (descriptor.capabilities?.functionCalling !== true) {
          throw new LlmError(
            `tools is not supported for google model "${model}" (capabilities.functionCalling is not true).`,
            { kind: 'bad_request', retryable: false, provider: 'google' },
          )
        }
        if (googleProviderConfig.tools !== undefined) {
          throw new LlmError(
            'tools cannot be combined with providerOptions.google.tools (googleSearch): this adapter does not send function declarations and Search in one request.',
            { kind: 'bad_request', retryable: false, provider: 'google' },
          )
        }
        const toolProfile = googleJsonSchemaProfile(descriptor.model)
        req.tools.forEach((tool, index) => {
          assertJsonSchemaProfile(
            tool.inputJsonSchema,
            `tools[${index}].inputJsonSchema`,
            toolProfile,
          )
        })
        config.tools = [
          {
            functionDeclarations: req.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.inputJsonSchema,
            })),
          },
        ]
        if (req.toolChoice !== undefined) {
          config.toolConfig = {
            functionCallingConfig: mapGoogleToolChoice(req.toolChoice),
          }
        }
      }

      // Gemini rejects a request that sets `system_instruction`, `tools` or
      // `tool_config` together with `cachedContent`: they must live in the cache
      // (`GoogleCacheStore.create` accepts them). Reject before dispatch.
      if (config.cachedContent !== undefined) {
        const conflicts = [
          ...(system !== undefined ? ['system'] : []),
          ...(req.tools !== undefined && req.tools.length > 0 ? ['tools'] : []),
          ...(googleProviderConfig.tools !== undefined
            ? ['providerOptions.google.tools']
            : []),
        ]
        if (conflicts.length > 0) {
          throw new LlmError(
            `providerOptions.google.cachedContent cannot be combined with ${conflicts.join(
              ' or ',
            )} for model "${model}": Gemini requires the system instruction and tools to be stored in the cache. Put them in GoogleCacheStore.create and omit them from the request.`,
            {
              kind: 'bad_request',
              retryable: false,
              provider: 'google',
              issues: conflicts.map((path) => ({
                path,
                message: 'cannot be sent with cachedContent',
              })),
            },
          )
        }
      }

      // ------------------------------------------------------------------
      // 5a. Fixed-sampling models reject sampling params even when a custom
      //     descriptor or direct adapter test bypasses core parsing.
      // ------------------------------------------------------------------
      assertSamplingAllowed(config, model, descriptor.capabilities?.sampling)

      // ------------------------------------------------------------------
      // 6. AbortSignal passthrough + client-side tier ceiling
      //
      // @google/genai issue #1277: on SDK versions before 2.0.0,
      // httpOptions.timeout is a no-op for generateContent. Upstream landed a
      // related Undici dispatcher fix in 2.0.0 (commit 850f680), so this
      // ceiling is now a second guard, not the only one. On explicit flex calls
      // without timeoutMs, the engine arms NO AbortSignal; relying solely on
      // httpOptions.timeout risks a silent hang. We arm our own
      // AbortController here and combine it with any incoming signal so WE
      // enforce the ceiling regardless of the SDK bug.
      //
      // Flex and standard default paths need this extra timer when timeoutMs is
      // absent. When timeoutMs IS set the engine already arms a hard AbortSignal
      // at exactly timeoutMs.
      //
      // Abort reason uses DOMException with name 'TimeoutError' so classifyError
      // maps the resulting LlmError to kind:'timeout' (retryable:true), matching
      // how the rest of the codebase surfaces timeout errors.
      //
      // AbortSignal.any requires Node ≥ 20.3; our engine floor is Node ≥ 22.12,
      // so this is always available in supported environments.
      //
      // Real SDK: GenerateContentConfig.abortSignal (in config, NOT in params)
      // ------------------------------------------------------------------
      // The ceiling runs on the engine's scheduler (`ctx.scheduler`, which a host
      // test replaces with a FakeClock); the platform's timers only when the
      // adapter is called outside the engine.
      const timers: Scheduler = ctx.scheduler ?? PLATFORM_SCHEDULER
      let tierTimeoutHandle: TimerHandle | undefined
      // Set when this adapter's own client-side ceiling fired (see below).
      let ceilingFiredMs: number | undefined

      const clearTierTimeout = (): void => {
        ceilingFiredMs = undefined
        if (tierTimeoutHandle !== undefined) {
          timers.clearTimeout(tierTimeoutHandle)
          tierTimeoutHandle = undefined
        }
      }

      const applyTierTimeout = (tier: string | undefined): void => {
        clearTierTimeout()
        delete config.abortSignal

        const defaultTimeoutMs =
          genConfig.timeoutMs === undefined
            ? tier === 'flex'
              ? FLEX_DEFAULT_TIMEOUT_MS
              : tier === 'standard'
                ? STANDARD_DEFAULT_TIMEOUT_MS
                : undefined
            : undefined

        if (defaultTimeoutMs !== undefined) {
          const tierController = new AbortController()
          const tierLabel = tier === 'standard' ? 'Standard' : 'Flex'
          const timeoutReason = new DOMException(
            `${tierLabel} timeout: call exceeded ${defaultTimeoutMs}ms client-side ceiling` +
              ' (@google/genai #1277 belt-and-suspenders)',
            'TimeoutError',
          )
          tierTimeoutHandle = timers.setTimeout(() => {
            ceilingFiredMs = defaultTimeoutMs
            tierController.abort(timeoutReason)
          }, defaultTimeoutMs)
          config.abortSignal =
            ctx.signal !== undefined
              ? AbortSignal.any([tierController.signal, ctx.signal])
              : tierController.signal
        } else if (ctx.signal !== undefined) {
          config.abortSignal = ctx.signal
        }
      }

      applyTierTimeout(config.serviceTier)

      // ------------------------------------------------------------------
      // 7. Transport timeout — set httpOptions.timeout so the @google/genai
      //    HTTP transport does NOT preempt the AbortSignal hard ceiling.
      //
      //    Policy (precedence, highest first):
      //    1. Caller-supplied providerOptions.google.httpOptions.timeout wins.
      //    2. timeoutMs is set → computed transport timeout = timeoutMs +
      //       TRANSPORT_TIMEOUT_BUFFER_MS so the engine's AbortSignal (hard
      //       ceiling at timeoutMs) always fires before the SDK transport timer.
      //    3. serviceTier 'flex', no timeoutMs → FLEX_DEFAULT_TIMEOUT_MS (no
      //       buffer; there is no engine AbortSignal deadline in this case).
      //    4. serviceTier 'standard', no timeoutMs → STANDARD_DEFAULT_TIMEOUT_MS.
      //
      //    Only assign config.httpOptions when the merged object is non-empty
      //    (exactOptionalPropertyTypes-safe).
      // ------------------------------------------------------------------

      // Capture caller-supplied httpOptions BEFORE we overwrite.
      // These arrived via the allowlisted provider-options mapper above.
      const callerHttpOptions = config.httpOptions

      const computedTimeoutMs: number | undefined =
        genConfig.timeoutMs !== undefined
          ? genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
          : config.serviceTier === 'flex'
            ? FLEX_DEFAULT_TIMEOUT_MS
            : config.serviceTier === 'standard'
              ? STANDARD_DEFAULT_TIMEOUT_MS
              : undefined

      const mergedHttpOptions: { timeout?: number } = {
        ...(computedTimeoutMs !== undefined ? { timeout: computedTimeoutMs } : {}),
        ...callerHttpOptions,
      }

      if (Object.keys(mergedHttpOptions).length > 0) {
        config.httpOptions = mergedHttpOptions
      }

      // ------------------------------------------------------------------
      // 8b. Client construction + SDK call — both inside the classifier
      //     so that ANY failure in run() (including a bad auth constructor)
      //     is rethrown as a typed LlmError(provider:'google').
      // ------------------------------------------------------------------
      let response: GeminiResponseShape
      let servedServiceTier = config.serviceTier
      const dispatch = async (): Promise<GeminiResponseShape> => {
        const dispatchConfig: GeminiGenerateConfig = {
          ...config,
          ...(config.httpOptions !== undefined
            ? { httpOptions: { ...config.httpOptions } }
            : {}),
        }
        const params = {
          model,
          contents,
          config: dispatchConfig,
        }
        const client: GeminiClientLike =
          injectedClient !== undefined ? injectedClient : await buildClient(ctx.auth)
        ctx.logger.debug(
          {
            model,
            configKeys: Object.keys(dispatchConfig),
            serviceTier: dispatchConfig.serviceTier,
          },
          'llm.adapter.dispatch',
        )
        return client.models.generateContent(params)
      }
      // What ended a call that nobody asked to end, when it was this adapter's
      // own timer or the SDK's: the client-side ceiling, or the SDK's transport
      // timer (it aborts its own request with a plain `AbortError`). The caller's
      // abort and the engine's deadline abort `ctx.signal`, and the engine answers
      // those itself. Not retryable: the same limit is reached again, and Google
      // may already have run, and billed, the request.
      const transportTimeoutOf = (rawErr: unknown): string | undefined => {
        if (ctx.signal?.aborted === true) return undefined
        if (ceilingFiredMs !== undefined) {
          return `Google call hit the ${ceilingFiredMs}ms client-side ceiling`
        }
        const sdkTimeoutMs = config.httpOptions?.timeout
        if (
          sdkTimeoutMs !== undefined &&
          rawErr instanceof Error &&
          rawErr.name === 'AbortError'
        ) {
          return `Google call hit the SDK transport timeout of ${sdkTimeoutMs}ms`
        }
        return undefined
      }
      try {
        response = await dispatch()
      } catch (rawErr) {
        // Classify SDK errors → LlmError
        const transportTimeout = transportTimeoutOf(rawErr)
        const typed = classifyGoogleError(rawErr, {
          ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
          ...(transportTimeout !== undefined ? { transportTimeout } : {}),
        })

        if (
          config.serviceTier === 'flex' &&
          googleProviderConfig.flexFallback !== false &&
          isGeminiCapacityError(typed)
        ) {
          config.serviceTier = 'standard'
          servedServiceTier = 'standard'
          warnings.push({
            type: 'other',
            message: `google: the flex call hit a capacity error (${
              typed.httpStatus ?? 'no status'
            }) and was sent again at the standard tier, billed at standard rates.${
              genConfig.timeoutMs === undefined
                ? ` Without timeoutMs the standard attempt runs under the ${STANDARD_DEFAULT_TIMEOUT_MS} ms client-side ceiling, not the flex ${FLEX_DEFAULT_TIMEOUT_MS} ms one.`
                : ''
            }`,
          })
          const fallbackTimeout =
            genConfig.timeoutMs !== undefined
              ? genConfig.timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS
              : STANDARD_DEFAULT_TIMEOUT_MS
          config.httpOptions = {
            timeout: fallbackTimeout,
            ...callerHttpOptions,
          }
          applyTierTimeout('standard')
          try {
            response = await dispatch()
          } catch (fallbackRawErr) {
            const fallbackTransportTimeout = transportTimeoutOf(fallbackRawErr)
            throw classifyGoogleError(fallbackRawErr, {
              servedServiceTier: 'standard',
              ...(fallbackTransportTimeout !== undefined
                ? { transportTimeout: fallbackTransportTimeout }
                : {}),
            })
          }
        } else {
          throw typed
        }
      } finally {
        // Always clear the tier timeout timer so it never leaks,
        // regardless of whether the call succeeded, threw, or was aborted.
        clearTierTimeout()
      }

      // The Gemini Developer API echoes the tier actually served in usage
      // metadata. Prefer that over the requested tier, including on success
      // after a provider-side tier change, so pricing uses the correct lane.
      const echoedTier = response.usageMetadata?.serviceTier
      if (typeof echoedTier === 'string' && echoedTier.length > 0) {
        if (config.serviceTier !== undefined && echoedTier !== config.serviceTier) {
          warnings.push({
            type: 'other',
            message: `google: requested serviceTier "${config.serviceTier}" but provider served "${echoedTier}"; billing uses the served tier.`,
          })
        }
        servedServiceTier = echoedTier
      }

      // ------------------------------------------------------------------
      // 8. Blocked response check. A candidate-less HTTP 200 without a
      // blockReason is a provider failure, not evidence of a safety block.
      // ------------------------------------------------------------------
      const hasBlockReason = response.promptFeedback?.blockReason !== undefined
      const candidate = response.candidates?.[0]

      if (hasBlockReason || candidate === undefined) {
        const reason = response.promptFeedback?.blockReason ?? 'NO_CANDIDATES'
        const thoughtTokens = response.usageMetadata?.thoughtsTokenCount ?? 0
        // The usual cause of a candidate-less 200 that billed reasoning is a
        // cap spent on thinking, so name it. The payload does not prove the cause,
        // but the same request with the same cap is billed again and fails the
        // same way, so such a failure is not retried; a candidate-less 200 that
        // billed no reasoning has no such evidence and stays retryable.
        const reasoningHint =
          !hasBlockReason && thoughtTokens > 0
            ? `. The call billed ${thoughtTokens} reasoning tokens, and maxOutputTokens (${
                config.maxOutputTokens ?? 'the provider default'
              }) includes reasoning tokens, so a low cap can be used up by reasoning before any answer is produced`
            : ''
        const promptRatings = hasBlockReason
          ? describeSafetyRatings(response.promptFeedback?.safetyRatings)
          : ''
        throw new LlmError(
          `Gemini response has no usable candidate: ${reason}${
            promptRatings !== '' ? ` (safetyRatings: ${promptRatings})` : ''
          }${reasoningHint}`,
          {
            kind: hasBlockReason ? 'content_filter' : 'server',
            retryable: !hasBlockReason && thoughtTokens === 0,
            provider: 'google',
            ...billedFailure(response.usageMetadata),
            ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
          },
        )
      }

      // ------------------------------------------------------------------
      // 9. Map response
      // ------------------------------------------------------------------
      const groundingMetadata = candidate.groundingMetadata
      const parts = candidate.content?.parts ?? []

      // A function call is complete only when the candidate ended normally
      // (`STOP`, or no finish reason). Alongside any other finish (`MAX_TOKENS`
      // cut it, `SAFETY` filtered it, `OTHER` and the rest) it is not a call a
      // host may run: it is dropped from `toolCalls` and from the assistant
      // message, and a warning names it. The finish reason then says why.
      const callsComplete =
        candidate.finishReason === undefined || candidate.finishReason === 'STOP'
      const isFunctionCall = (part: (typeof parts)[number]): boolean =>
        part.functionCall !== undefined && typeof part.functionCall.name === 'string'

      // An output-side filter stop that produced neither answer text nor a
      // complete tool call is a failure, like a blocked prompt: `content_filter`,
      // not retryable (the same call is refused again), billed. A stop that kept
      // partial text is returned with `finishReason: 'content_filter'`.
      const hasAnswer = parts.some(
        (part) =>
          (part.thought !== true &&
            typeof part.text === 'string' &&
            part.text.length > 0) ||
          (callsComplete && isFunctionCall(part)),
      )
      const filteredCandidateError = (note: string): LlmError => {
        const finishMessage =
          candidate.finishMessage !== undefined
            ? truncateText(candidate.finishMessage, MAX_FINISH_MESSAGE_CHARS)
            : undefined
        const ratings = describeSafetyRatings(candidate.safetyRatings)
        const bounded = { truncated: false }
        return new LlmError(
          `Gemini candidate was filtered (finishReason ${candidate.finishReason}${
            finishMessage !== undefined ? `: ${finishMessage}` : ''
          }${ratings !== '' ? `; safetyRatings: ${ratings}` : ''}); ${note}. The attempt was billed.`,
          {
            kind: 'content_filter',
            retryable: false,
            provider: 'google',
            // The raw evidence, bounded: which category blocked, and why.
            cause: {
              finishReason: candidate.finishReason ?? null,
              ...(finishMessage !== undefined ? { finishMessage } : {}),
              ...(candidate.safetyRatings !== undefined
                ? { safetyRatings: boundMetadata(candidate.safetyRatings, bounded) }
                : {}),
            },
            ...billedFailure(response.usageMetadata, groundingMetadata),
            ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
          },
        )
      }
      if (mapFinishReason(candidate.finishReason) === 'content_filter' && !hasAnswer) {
        throw filteredCandidateError(
          'it carries no answer text and no complete tool call',
        )
      }

      // requireGrounding fails closed: only a response that reports at least one
      // search query proves Search ran. It is judged only on a candidate that
      // finished normally (STOP, or no finish reason): a filtered candidate
      // surfaces its real error, and a truncated one returns `length`, because
      // neither outcome is evidence about Search and a retry would repeat it.
      if (requireGrounding) {
        const queries = countWebSearchQueries(groundingMetadata)
        if (groundingMetadata === undefined || queries === undefined || queries < 1) {
          const finishReason = mapFinishReason(candidate.finishReason)
          if (finishReason === 'content_filter') {
            throw filteredCandidateError('the grounding check was not applied')
          }
          if (candidate.finishReason === undefined || candidate.finishReason === 'STOP') {
            const why =
              groundingMetadata === undefined
                ? 'the response has no groundingMetadata'
                : queries === undefined
                  ? 'groundingMetadata has no webSearchQueries'
                  : 'groundingMetadata reports zero webSearchQueries'
            // A call without a response schema grounded in 4 of 4 captured
            // calls, so a retry may ground. With a schema attached the same
            // request missed on every capture of five of six Gemini 3 models, so
            // a retry repeats a billed failure: not retryable.
            const retryable = !structuredOutputRequested
            throw new LlmError(
              `google: requireGrounding is set but there is no evidence that Search ran: ${why}. The attempt was billed for its tokens${
                retryable
                  ? '; a retry may ground.'
                  : '; it is not retryable, because a call with a response schema attached keeps missing (use the two-call recipe in docs/grounded-structured.md).'
              }`,
              {
                kind: 'server',
                retryable,
                reason: 'grounding_missing',
                provider: 'google',
                ...billedFailure(response.usageMetadata, groundingMetadata),
                ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
              },
            )
          }
        }
      }

      // Separate thought parts from text parts, and build the ordered assistant
      // message (provider order, thought parts omitted) with the signatures the
      // model issued for it.
      const textParts: string[] = []
      const thoughtParts: string[] = []
      const toolCalls: NonNullable<AdapterResult['toolCalls']> = []
      const messageParts: Part[] = []
      const issuedSignatures: Array<{ partIndex: number; signature: string }> = []
      let droppedSignatures = 0

      const droppedCalls: string[] = []
      const nameCounts = new Map<string, number>()
      // Reserve the provider's ids and every id already in the history, so a
      // synthesized id is unique within the conversation.
      const reservedIds = reserveProviderToolCallIds([
        ...parts.map((part) => part.functionCall?.id),
        ...req.messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.kind === 'tool-call' || part.kind === 'tool-result'
              ? [part.toolCallId]
              : [],
          ),
        ),
      ])
      for (const part of parts) {
        const signature =
          typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
            ? part.thoughtSignature
            : undefined
        let represented = false
        if (isFunctionCall(part) && !callsComplete) {
          droppedCalls.push(part.functionCall?.name ?? '')
          represented = true
        } else if (
          part.functionCall !== undefined &&
          typeof part.functionCall.name === 'string'
        ) {
          const toolName = part.functionCall.name
          const call = {
            toolCallId: resolveToolCallId(
              part.functionCall.id,
              toolName,
              nameCounts,
              reservedIds,
            ),
            toolName,
            args: (part.functionCall.args ?? {}) as JsonValue,
          }
          toolCalls.push(call)
          if (signature !== undefined) {
            issuedSignatures.push({ partIndex: messageParts.length, signature })
          }
          messageParts.push({ kind: 'tool-call', ...call })
          represented = true
        }
        if (part.text !== undefined) {
          if (part.thought === true) {
            thoughtParts.push(part.text)
          } else {
            textParts.push(part.text)
            if (part.text.length > 0) {
              if (signature !== undefined && !represented) {
                issuedSignatures.push({ partIndex: messageParts.length, signature })
              }
              messageParts.push({ kind: 'text', text: part.text })
              represented = true
            }
          }
        }
        if (signature !== undefined && !represented) droppedSignatures += 1
      }

      if (droppedCalls.length > 0) {
        const named = droppedCalls.map((name) => `"${name}"`).join(', ')
        warnings.push({
          type: 'other',
          message: `google: dropped ${droppedCalls.length} function call(s) (${named}) because the candidate ended with finishReason ${candidate.finishReason ?? 'unspecified'}, not STOP: ${
            candidate.finishReason === 'MAX_TOKENS'
              ? 'the call was cut by the output cap and is incomplete'
              : 'a call beside an abnormal stop is not a call to run'
          }. The result carries no tool call; finishReason is "${mapFinishReason(candidate.finishReason) ?? 'other'}".`,
        })
      }

      const text = textParts.join('')
      const reasoningText = thoughtParts.length > 0 ? thoughtParts.join('') : undefined

      // The result's state is the incoming overlay plus one entry per part of
      // this message the model signed, bound to the index the host will append
      // the message at and to the model string this request named.
      let transientProviderState: JsonValue | undefined
      if (signsHistory) {
        const issued: GoogleSignatureEntry[] = []
        for (const { partIndex, signature } of issuedSignatures) {
          const part = messageParts[partIndex] as Part
          try {
            issued.push(
              signatureEntry(req.messages.length, partIndex, model, part, signature),
            )
          } catch (error) {
            // The call is already billed: never fail it for a part that cannot be
            // hashed (a lone surrogate in provider output). Return the result without
            // an entry; replaying a call that lacks one is rejected on the next turn.
            if (!(error instanceof LlmError)) throw error
            warnings.push({
              type: 'other',
              message: `google: no signature entry for messages.${req.messages.length}.parts.${partIndex} (a "${part.kind}" part): ${error.message} The result is returned without it; ${
                part.kind === 'tool-call'
                  ? 'replaying this function call on the next turn will be rejected'
                  : 'a text signature is optional, so nothing required is lost'
              }.`,
            })
          }
        }
        const signatures = [...incomingSignatures, ...issued]
        if (signatures.length > 0) {
          transientProviderState = { google: { signatures } }
        }
        if (droppedSignatures > 0) {
          warnings.push({
            type: 'other',
            message: `google: dropped ${droppedSignatures} thoughtSignature(s) on parts that have no message representation (thought or empty parts); Gemini requires only the function-call ones.`,
          })
        }
        const firstCall = messageParts.findIndex((part) => part.kind === 'tool-call')
        if (
          firstCall !== -1 &&
          !issuedSignatures.some((entry) => entry.partIndex === firstCall)
        ) {
          warnings.push({
            type: 'other',
            message:
              'google: the first function call in this response carries no thoughtSignature; replaying it on the next turn will be rejected.',
          })
        }
      }

      // Parse structured output (JSON text → rawStructured).
      let rawStructured: unknown
      if (structuredOutputRequested && text.length > 0) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          // Core reports outputParsed:false; callers own validation/retry policy.
          // Gemma wraps its answer in a markdown fence often enough to name the
          // cause; the text is returned as sent, never unwrapped here.
          if (descriptor.model.startsWith('gemma-') && /^\s*```/.test(text)) {
            warnings.push({
              type: 'other',
              message: `google: gemma_fenced_json: the answer from "${model}" is wrapped in a markdown code fence, so it is not parseable JSON and outputParsed is false. Gemma 4 fenced 67 of 162 schema answers (41%) in a live probe (2026-10-03) although the schema is native. The text is returned as the model sent it; call again, or unwrap the fence on the host side.`,
            })
          }
        }
      }

      // ------------------------------------------------------------------
      // 10. Build AdapterResult
      // ------------------------------------------------------------------
      const usage = usageFor(response.usageMetadata, groundingMetadata)
      // A 200 without `usageMetadata` billed tokens nobody reported: the usage
      // is unknown, not zero. The marker makes the pricing source report the
      // call unpriced (`microUsd: null`, estimated) instead of an exact $0.
      if (response.usageMetadata === undefined) {
        usage.details['usage_missing'] = 1
        warnings.push({
          type: 'other',
          message:
            'google: the response carries no usageMetadata, so token usage is unknown; the call is recorded with zero tokens and is not priced (cost.microUsd is null, cost.confidence is "estimated").',
        })
      }
      const finishReason = mapFinishReason(candidate.finishReason)
      warnings.push(...groundingWarnings(groundingMetadata))
      warnings.push(...modalityWarnings(response.usageMetadata))

      // Where each answer-text part sits in `text`, so a grounding segment
      // (UTF-8 byte offsets into one part) becomes a range of `text`. Gemini's
      // `partIndex` does not count thought parts (see `AnswerTextPart`).
      const answerParts: Array<AnswerTextPart | undefined> = []
      let answerOffset = 0
      for (const part of parts) {
        if (part.thought === true) continue
        if (typeof part.text === 'string') {
          answerParts.push({ text: part.text, offset: answerOffset })
          answerOffset += part.text.length
        } else {
          answerParts.push(undefined)
        }
      }

      const result: AdapterResult = {
        model,
        message: { role: 'assistant', parts: messageParts },
        usage,
        warnings,
        ...(transientProviderState !== undefined ? { transientProviderState } : {}),
        ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(toolCalls.length > 0
          ? { toolCalls, finishReason: 'tool_calls' }
          : finishReason !== undefined
            ? { finishReason }
            : {}),
        ...(response.modelVersion !== undefined
          ? { modelVersion: response.modelVersion }
          : {}),
        ...(response.responseId !== undefined ? { responseId: response.responseId } : {}),
        // Build providerMetadata — merge promptFeedback + groundingMetadata when
        // present. `google.searchEntryPoint` is the Search Suggestions widget
        // Google requires a grounded answer to display.
        ...((): { providerMetadata: JsonValue } | Record<string, never> => {
          const pf = response.promptFeedback
          const gm = groundingMetadata
          // The candidate's own fields (raw finish reason and message, safety
          // ratings, citation and URL-context metadata), so a host can tell a
          // malformed tool call from a language refusal behind `'other'`.
          const candidateFields: { [k: string]: JsonValue } = {}
          const bounded = { truncated: false }
          for (const key of CANDIDATE_METADATA_KEYS) {
            const value = (candidate as unknown as Record<string, unknown>)[key]
            if (value === undefined) continue
            candidateFields[key] =
              key === 'finishMessage' && typeof value === 'string'
                ? (() => {
                    if (value.length > MAX_FINISH_MESSAGE_CHARS) bounded.truncated = true
                    return truncateText(value, MAX_FINISH_MESSAGE_CHARS)
                  })()
                : boundMetadata(value, bounded)
          }
          const googleMeta: { [k: string]: JsonValue } = {}
          if (Object.keys(candidateFields).length > 0) {
            googleMeta['candidate'] = candidateFields
          }
          if (
            pf === undefined &&
            gm === undefined &&
            Object.keys(googleMeta).length === 0
          ) {
            return {}
          }
          const meta: { [k: string]: JsonValue } = {}
          // `promptFeedback` and `groundingMetadata` are bounded like the
          // candidate fields: `webSearchQueries` come from the user's prompt and
          // every `groundingSupports[].segment.text` copies the answer.
          if (pf !== undefined) {
            meta['promptFeedback'] = boundMetadata(pf, bounded)
          }
          if (gm !== undefined) {
            const searchEntryPoint = readSearchEntryPoint(gm)
            if (searchEntryPoint !== undefined) {
              // Stored once, under `google.searchEntryPoint`: the widget HTML is
              // kilobytes and `providerMetadata` is persisted on every grounded
              // row, so the raw copy omits it.
              const { searchEntryPoint: _widget, ...rest } = gm as Record<string, unknown>
              meta['groundingMetadata'] = boundMetadata(rest, bounded)
              googleMeta['searchEntryPoint'] = searchEntryPoint
            } else {
              meta['groundingMetadata'] = boundMetadata(gm, bounded)
            }
          }
          if (bounded.truncated) {
            warnings.push({
              type: 'other',
              message: `google: providerMetadata was truncated (finishMessage over ${MAX_FINISH_MESSAGE_CHARS} characters, a string over ${MAX_METADATA_STRING}, a list over ${MAX_METADATA_ARRAY} entries or nesting over ${MAX_METADATA_DEPTH} levels, in the candidate fields, promptFeedback or groundingMetadata); the citations are built from the full response.`,
            })
          }
          if (Object.keys(googleMeta).length > 0) meta['google'] = googleMeta
          return { providerMetadata: meta as JsonValue }
        })(),
        ...(() => {
          if (groundingMetadata === undefined) return {}
          const citations = normalizeGroundingCitations(
            groundingMetadata,
            answerParts,
            (message) => warnings.push({ type: 'other', message }),
          )
          return citations.length > 0 ? { citations } : {}
        })(),
      }

      return result
    },

    async countTokens(req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> {
      if (req.provider !== 'google') {
        throw new LlmError(
          `geminiAdapter received a request for provider "${req.provider}", expected "google".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      // The SDK's Gemini Developer API `countTokens` carries only `contents`, so
      // a `system` or `tools` count goes through the REST `generateContentRequest`
      // form (see `buildGoogleClient`). The count covers `messages`, `system` and
      // `tools`; it carries no response schema, thinking config, `toolConfig`,
      // safety settings or Search tool, which `generate()` also sends. An empty
      // system string adds no tokens and is treated as absent.
      const system =
        req.system !== undefined && req.system !== '' ? req.system : undefined
      const tools =
        req.tools !== undefined && req.tools.length > 0 ? req.tools : undefined
      if (tools !== undefined) {
        const descriptor = ctx.modelDescriptor
        if (
          descriptor !== undefined &&
          descriptor.capabilities?.functionCalling !== true
        ) {
          throw new LlmError(
            `tools is not supported for google model "${req.model}" (capabilities.functionCalling is not true).`,
            { kind: 'bad_request', retryable: false, provider: 'google' },
          )
        }
        const toolProfile = googleJsonSchemaProfile(descriptor?.model ?? req.model)
        tools.forEach((tool, index) => {
          assertJsonSchemaProfile(
            tool.inputJsonSchema,
            `tools[${index}].inputJsonSchema`,
            toolProfile,
          )
        })
      }

      if (ctx.modelDescriptor !== undefined) {
        assertInputMimeTypesAdmitted(req.messages, ctx.modelDescriptor, 'google')
      }
      const contents = mapMessagesToGeminiContents(req.messages)
      assertInlinePayloadWithinLimits(contents, system)
      const params: GeminiCountTokensParams = {
        model: req.model,
        contents,
        ...(system !== undefined
          ? { systemInstruction: { parts: [{ text: system }] } }
          : {}),
        ...(tools !== undefined
          ? {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.inputJsonSchema,
                  })),
                },
              ],
            }
          : {}),
        ...(ctx.signal !== undefined ? { config: { abortSignal: ctx.signal } } : {}),
      }

      try {
        const client: GeminiClientLike =
          injectedClient !== undefined ? injectedClient : await buildClient(ctx.auth)
        const response = await client.models.countTokens(params)

        if (response.totalTokens === undefined) {
          // Provider fault, not caller fault: the SDK call succeeded but the
          // payload is malformed — classify as a (retryable) server error.
          throw new LlmError(
            'Gemini countTokens response is malformed: missing required field: totalTokens',
            { kind: 'server', retryable: true, provider: 'google' },
          )
        }

        const details: Record<string, number> | undefined =
          response.cachedContentTokenCount !== undefined
            ? { cached: response.cachedContentTokenCount }
            : undefined

        // Gemini 3 bills each replayed thought signature (about 110 prompt tokens
        // each) and countTokens carries none, so a history with function calls
        // is counted short of what generate() will bill. Live capture
        // 2026-10-03: the endpoint accepts function calls without signatures and
        // returns the same count with or without them.
        const omitsSignatures =
          ctx.modelDescriptor?.capabilities?.providerState === true &&
          req.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.parts.some((part) => part.kind === 'tool-call'),
          )

        return {
          totalTokens: response.totalTokens,
          accuracy: omitsSignatures ? 'estimated' : 'exact',
          ...(details !== undefined ? { details } : {}),
          raw: response as unknown as JsonValue,
        }
      } catch (rawErr) {
        throw classifyGoogleError(rawErr)
      }
    },
  }
}
