/**
 * geminiAdapter — @gullabs/google Gemini provider adapter.
 *
 * Pure request⇄response mapping over @google/genai (via GeminiClientLike).
 * Never persists, never computes cost, never loops.
 *
 * @module
 */

import { LlmError, assertNever, assertModelMatchesDescriptor } from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
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
  STANDARD_DEFAULT_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from './client.js'
import { GOOGLE_REASONING_EFFORT_BUDGET } from './reasoning-budget.js'
import { normalizeGroundingCitations } from './grounding.js'
import { reserveProviderToolCallIds, resolveToolCallId } from './tool-call-id.js'
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
import { GOOGLE_SEARCH_REQUESTED_DETAIL } from './cost.js'
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
  'cachedContent',
  'flexFallback',
  'httpOptions',
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

  if (typeof setting['category'] !== 'string' || setting['category'].length === 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}].category must be a non-empty string for model "${model}".`,
    )
  }

  if (typeof setting['threshold'] !== 'string' || setting['threshold'].length === 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google.safetySettings[${index}].threshold must be a non-empty string for model "${model}".`,
    )
  }

  return {
    category: setting['category'],
    threshold: setting['threshold'],
  }
}

function mapGoogleProviderOptions({
  googleOpts,
  model,
  structuredOutputRequested,
  descriptorGrounding,
  structuredOutputWithTools,
}: {
  googleOpts: unknown
  model: string
  structuredOutputRequested: boolean
  descriptorGrounding: boolean | undefined
  structuredOutputWithTools: boolean | undefined
}): Partial<GeminiDispatchConfig> & { flexFallback?: boolean } {
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
    (key) =>
      !ALLOWED_GOOGLE_PROVIDER_OPTION_KEYS.has(key) &&
      !RESERVED_GOOGLE_PROVIDER_OPTION_KEYS.has(key),
  )
  if (unknownKeys.length > 0) {
    throw badGoogleProviderOptions(
      `providerOptions.google contains unsupported keys [${unknownKeys.join(
        ', ',
      )}] for model "${model}". Allowed keys: cachedContent, flexFallback, httpOptions, safetySettings, tools.`,
    )
  }

  const mapped: Partial<GeminiDispatchConfig> & { flexFallback?: boolean } = {}

  if (googleOpts['cachedContent'] !== undefined) {
    if (
      typeof googleOpts['cachedContent'] !== 'string' ||
      googleOpts['cachedContent'].length === 0
    ) {
      throw badGoogleProviderOptions(
        `providerOptions.google.cachedContent must be a non-empty string for model "${model}".`,
      )
    }
    mapped.cachedContent = googleOpts['cachedContent']
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
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
        throw badGoogleProviderOptions(
          `providerOptions.google.httpOptions.timeout must be a positive integer for model "${model}".`,
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
      throw badGoogleProviderOptions(
        `Structured output with googleSearch is not enabled for model "${model}": the provider accepts the request but Search does not reliably run when a response schema is attached. Make two calls instead: grounded research without a schema, then structured synthesis (the two-call recipe in docs/grounded-structured.md).`,
      )
    }

    mapped.tools = tools
  }

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
// Exported types for consumers that inject a custom client
// ---------------------------------------------------------------------------
export type { GeminiClientLike }

// ---------------------------------------------------------------------------
// FinishReason mapping (Gemini SDK enum → our FinishReason)
// ---------------------------------------------------------------------------

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
    case 'IMAGE_SAFETY':
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
          id: p.toolCallId,
          name: p.toolName,
          args: p.args,
        },
        ...(signature !== undefined ? { thoughtSignature: signature } : {}),
      }

    case 'tool-result':
      return {
        functionResponse: {
          id: p.toolCallId,
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
  /**
   * @internal Testing-only.
   *
   * Override the default `buildGoogleClient` factory.  Allows unit tests to
   * simulate construction failures (e.g. bad credentials) without importing
   * the real `@google/genai` SDK.  Never set this in production code.
   */
  _clientFactory?: (auth: AuthMaterial) => GeminiClientLike | Promise<GeminiClientLike>
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

      const incomingSignatures: GoogleSignatureEntry[] = signsHistory
        ? parseSignatureState(req.transientProviderState)
        : []
      const replaySignatures = signsHistory
        ? resolveSignatures(incomingSignatures, req.messages, model)
        : undefined
      const contents: GeminiContent[] = mapMessagesToGeminiContents(
        req.messages,
        replaySignatures,
      )

      // ------------------------------------------------------------------
      // 2. Build GenerateContentConfig
      // ------------------------------------------------------------------
      const genConfig = req.config
      const config: GeminiDispatchConfig = {}

      // System instruction
      if (req.system !== undefined) {
        config.systemInstruction = { parts: [{ text: req.system }] }
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
      // 4. Structured output → responseMimeType + responseSchema
      // ------------------------------------------------------------------
      const structuredOutputRequested = req.outputJsonSchema !== undefined
      if (structuredOutputRequested) {
        const nativeStructuredOutput =
          descriptor.capabilities?.nativeStructuredOutput !== false

        if (nativeStructuredOutput) {
          config.responseMimeType = 'application/json'
          config.responseSchema = req.outputJsonSchema as NonNullable<
            GeminiGenerateConfig['responseSchema']
          >
        }
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.google → explicit allowlisted mapping
      // ------------------------------------------------------------------
      const googleProviderConfig = mapGoogleProviderOptions({
        googleOpts: genConfig.providerOptions?.['google'],
        model,
        structuredOutputRequested,
        descriptorGrounding: descriptor.capabilities?.grounding,
        structuredOutputWithTools: descriptor.capabilities?.structuredOutputWithTools,
      })
      if (googleProviderConfig.cachedContent !== undefined) {
        config.cachedContent = googleProviderConfig.cachedContent
      }
      if (googleProviderConfig.httpOptions !== undefined) {
        config.httpOptions = googleProviderConfig.httpOptions
      }
      if (googleProviderConfig.safetySettings !== undefined) {
        config.safetySettings = googleProviderConfig.safetySettings
      }
      if (googleProviderConfig.tools !== undefined) {
        config.tools = googleProviderConfig.tools
      }

      if (req.tools !== undefined && req.tools.length > 0) {
        if (req.modelDescriptor?.capabilities?.functionCalling !== true) {
          throw new LlmError(
            `tools is not supported for google model "${model}" (capabilities.functionCalling is not true).`,
            { kind: 'bad_request', retryable: false, provider: 'google' },
          )
        }
        if (googleProviderConfig.tools !== undefined) {
          throw new LlmError(
            'tools cannot be combined with providerOptions.google.tools (googleSearch) in this iteration.',
            { kind: 'bad_request', retryable: false, provider: 'google' },
          )
        }
        config.tools = [
          {
            functionDeclarations: req.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputJsonSchema,
            })),
          },
        ]
        if (req.toolChoice !== undefined) {
          config.toolConfig = {
            functionCallingConfig: mapGoogleToolChoice(req.toolChoice),
          }
        }
      }

      // ------------------------------------------------------------------
      // 5a. Fixed-sampling models reject sampling params even when a custom
      //     descriptor or direct adapter test bypasses core parsing.
      // ------------------------------------------------------------------
      assertSamplingAllowed(config, model, req.modelDescriptor?.capabilities?.sampling)

      // ------------------------------------------------------------------
      // 6. AbortSignal passthrough + FIX A-2: client-side flex ceiling
      //
      // FIX A-2 belt-and-suspenders: @google/genai issue #1277 — on SDK
      // versions before 2.0.0, httpOptions.timeout is a no-op for
      // generateContent. Upstream landed a related Undici dispatcher fix in
      // 2.0.0 (commit 850f680), but we keep this mitigation as
      // belt-and-suspenders since it is now merely double-covered, not made
      // incorrect. On explicit flex calls without timeoutMs, the engine arms
      // NO AbortSignal; relying solely on
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
      // AbortSignal.any requires Node ≥ 20.3; our engine floor is Node ≥ 20,
      // so this is always available in supported environments.
      //
      // Real SDK: GenerateContentConfig.abortSignal (in config, NOT in params)
      // ------------------------------------------------------------------
      let tierTimeoutHandle: ReturnType<typeof setTimeout> | undefined

      const clearTierTimeout = (): void => {
        if (tierTimeoutHandle !== undefined) {
          clearTimeout(tierTimeoutHandle)
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
          tierTimeoutHandle = setTimeout(() => {
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
        const buildClient = opts?._clientFactory ?? buildGoogleClient
        const client: GeminiClientLike =
          opts?.client !== undefined ? opts.client : await buildClient(ctx.auth)
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
      try {
        response = await dispatch()
      } catch (rawErr) {
        // Classify SDK errors → LlmError
        const typed = classifyGoogleError(
          rawErr,
          servedServiceTier !== undefined ? { servedServiceTier } : undefined,
        )

        if (
          config.serviceTier === 'flex' &&
          googleProviderConfig.flexFallback !== false &&
          isGeminiCapacityError(typed)
        ) {
          config.serviceTier = 'standard'
          servedServiceTier = 'standard'
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
            throw classifyGoogleError(fallbackRawErr, { servedServiceTier: 'standard' })
          }
        } else {
          throw typed
        }
      } finally {
        // FIX A-2: always clear the tier timeout timer so it never leaks,
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
      const hasCandidates =
        response.candidates !== undefined && response.candidates.length > 0

      if (hasBlockReason || !hasCandidates) {
        const reason = response.promptFeedback?.blockReason ?? 'NO_CANDIDATES'
        const thoughtTokens = response.usageMetadata?.thoughtsTokenCount ?? 0
        // The usual cause of a candidate-less 200 that billed reasoning is a
        // cap spent on thinking, so name it. The payload does not prove the cause.
        const reasoningHint =
          !hasBlockReason && thoughtTokens > 0
            ? `. The call billed ${thoughtTokens} reasoning tokens, and maxOutputTokens (${
                config.maxOutputTokens ?? 'the provider default'
              }) includes reasoning tokens, so a low cap can be used up by reasoning before any answer is produced`
            : ''
        throw new LlmError(
          `Gemini response has no usable candidate: ${reason}${reasoningHint}`,
          {
            kind: hasBlockReason ? 'content_filter' : 'server',
            retryable: !hasBlockReason,
            provider: 'google',
            ...(response.usageMetadata !== undefined
              ? { usage: mapUsage(response.usageMetadata) }
              : {}),
            ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
          },
        )
      }

      // ------------------------------------------------------------------
      // 9. Map response
      // ------------------------------------------------------------------
      const candidates = response.candidates
      if (candidates === undefined || candidates.length === 0) {
        throw new LlmError('Gemini response has no usable candidate: NO_CANDIDATES', {
          kind: 'server',
          retryable: true,
          provider: 'google',
          ...(response.usageMetadata !== undefined
            ? { usage: mapUsage(response.usageMetadata) }
            : {}),
          ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        })
      }
      const candidate = candidates[0]
      if (candidate === undefined) {
        throw new LlmError('Gemini response has no usable candidate: NO_CANDIDATES', {
          kind: 'server',
          retryable: true,
          provider: 'google',
          ...(response.usageMetadata !== undefined
            ? { usage: mapUsage(response.usageMetadata) }
            : {}),
          ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        })
      }
      const parts = candidate.content?.parts ?? []

      // Separate thought parts from text parts, and build the ordered assistant
      // message (provider order, thought parts omitted) with the signatures the
      // model issued for it.
      const textParts: string[] = []
      const thoughtParts: string[] = []
      const toolCalls: NonNullable<AdapterResult['toolCalls']> = []
      const messageParts: Part[] = []
      const issuedSignatures: Array<{ partIndex: number; signature: string }> = []
      let droppedSignatures = 0

      const nameCounts = new Map<string, number>()
      const reservedIds = reserveProviderToolCallIds(
        parts.map((part) => part.functionCall?.id),
      )
      for (const part of parts) {
        const signature =
          typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
            ? part.thoughtSignature
            : undefined
        let represented = false
        if (
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

      const text = textParts.join('')
      const reasoningText = thoughtParts.length > 0 ? thoughtParts.join('') : undefined

      // The result's state is the incoming overlay plus one entry per part of
      // this message the model signed, bound to the index the host will append
      // the message at and to the model string this request named.
      let transientProviderState: JsonValue | undefined
      if (signsHistory) {
        const issued = issuedSignatures.map(({ partIndex, signature }) =>
          signatureEntry(
            req.messages.length,
            partIndex,
            model,
            messageParts[partIndex] as Part,
            signature,
          ),
        )
        const signatures = [...incomingSignatures, ...issued]
        if (signatures.length > 0) {
          transientProviderState = { google: { signatures } } as unknown as JsonValue
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
          !issuedSignatures.some((issued) => issued.partIndex === firstCall)
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
        }
      }

      // ------------------------------------------------------------------
      // 10. Build AdapterResult
      // ------------------------------------------------------------------
      const usage = mapUsage(response.usageMetadata)
      const finishReason = mapFinishReason(candidate.finishReason)

      // Grounding is billed per grounded prompt or query, which the token-only
      // price cannot see. Until grounding fees are priced, never call the cost exact.
      const googleSearchSent =
        googleProviderConfig.tools?.some((tool) => 'googleSearch' in tool) === true
      if (googleSearchSent) {
        // Synthetic, adapter-owned flag (the `details` lane is open and this key
        // is not a provider payload field): the pricing source cannot see the
        // request, so it reads this to mark the cost estimated.
        usage.details[GOOGLE_SEARCH_REQUESTED_DETAIL] = 1
        warnings.push({
          type: 'other',
          message:
            'google: googleSearch was sent; grounding fees are not included in cost, so cost.confidence is "estimated".',
        })
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
        // Build providerMetadata — merge promptFeedback + groundingMetadata when present.
        ...((): { providerMetadata: JsonValue } | Record<string, never> => {
          const pf = response.promptFeedback
          const gm = candidate.groundingMetadata
          if (pf === undefined && gm === undefined) return {}
          const meta: { [k: string]: JsonValue } = {}
          if (pf !== undefined) {
            meta['promptFeedback'] = pf as unknown as JsonValue
          }
          if (gm !== undefined) {
            meta['groundingMetadata'] = gm as unknown as JsonValue
          }
          return { providerMetadata: meta as JsonValue }
        })(),
        ...(() => {
          const gm = candidate.groundingMetadata
          if (gm === undefined) return {}
          const citations = normalizeGroundingCitations(gm)
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

      // The SDK's Gemini Developer API `countTokens` carries no `systemInstruction`
      // or `tools`, so a count that omitted them would be a lower bound reported
      // as exact. Fail before dispatch instead of sending a different request.
      const unsupported: string[] = []
      if (req.system !== undefined) {
        unsupported.push('system')
      }
      if (req.tools !== undefined && req.tools.length > 0) {
        unsupported.push('tools')
      }
      if (unsupported.length > 0) {
        throw new LlmError(
          `Google countTokens does not support ${unsupported.join(' or ')}: the token count would omit them. Count the messages alone, or read inputTokens from a generate() result.`,
          {
            kind: 'bad_request',
            retryable: false,
            provider: 'google',
            issues: unsupported.map((path) => ({
              path,
              message: 'not supported by Google countTokens',
            })),
          },
        )
      }

      const contents = mapMessagesToGeminiContents(req.messages)
      const params: GeminiCountTokensParams = {
        model: req.model,
        contents,
        ...(ctx.signal !== undefined ? { config: { abortSignal: ctx.signal } } : {}),
      }

      try {
        const buildClient = opts?._clientFactory ?? buildGoogleClient
        const client: GeminiClientLike =
          opts?.client !== undefined ? opts.client : await buildClient(ctx.auth)
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

        return {
          totalTokens: response.totalTokens,
          accuracy: 'exact',
          ...(details !== undefined ? { details } : {}),
          raw: response as unknown as JsonValue,
        }
      } catch (rawErr) {
        throw classifyGoogleError(rawErr)
      }
    },
  }
}
