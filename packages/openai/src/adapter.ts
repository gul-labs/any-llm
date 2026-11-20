/**
 * openaiAdapter — the `@gullabs/openai` provider adapter (Responses API).
 *
 * Pure request⇄response mapping over {@link OpenAiClientLike}. Never persists,
 * never computes cost, never retries. Every provider fact here is documented,
 * not live-verified (pages read 2026-11-20; ADR-047).
 *
 * @module
 */

import {
  LlmError,
  assertInputMimeTypesAdmitted,
  assertModelMatchesDescriptor,
  assertNever,
  classifyError,
} from '@gullabs/core'
import type {
  AdapterCtx,
  AdapterResult,
  AuthMaterial,
  FinishReason,
  JsonValue,
  Message,
  Part,
  ProviderAdapter,
  ResolvedRequest,
  Usage,
  Warning,
} from '@gullabs/core'

import {
  OPENAI_DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_BUFFER_MS,
  OpenAiStreamError,
  buildOpenAiClient,
} from './client.js'
import type {
  OpenAiClientLike,
  OpenAiFunctionTool,
  OpenAiInputContentPart,
  OpenAiOutputItem,
  OpenAiReplayState,
  OpenAiRequestInputItem,
  OpenAiResponseCreateParams,
  OpenAiResponseMeta,
  OpenAiResponseShape,
  OpenAiUsageShape,
} from './client.js'
import { assertOpenAiStrictSchema } from './json-schema.js'
import {
  OPENAI_INPUT_MIME_TYPES,
  OPENAI_MAX_IMAGES_PER_REQUEST,
  OPENAI_MAX_INLINE_IMAGE_PAYLOAD_BYTES,
} from './model-limits.js'
import { openaiRegistry } from './models.js'
import { OPENAI_USAGE_DETAIL_KEYS } from './pricing.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'openai',
  })
}

/** `value` cut to 500 characters, for a message that quotes provider text. */
function bounded(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value
}

/**
 * The structured-output `name`: the schema `title`, which must match the rule
 * the SDK typing states for `ResponseFormatTextJSONSchemaConfig.name` ("Must be
 * a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of
 * 64"). A schema with no title is sent as `structured_output`.
 */
const SCHEMA_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const DEFAULT_SCHEMA_NAME = 'structured_output'

// ---------------------------------------------------------------------------
// Image input (documented MIME types and URL forms; ADR-047)
// ---------------------------------------------------------------------------

/** A fully qualified `http(s)` URL with a host, or `undefined`. */
function httpUrl(uri: string): URL | undefined {
  try {
    const url = new URL(uri)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
      ? url
      : undefined
  } catch {
    return undefined
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** The media type of an admitted image data URL, or `undefined`. */
function dataUrlMediaType(value: string): string | undefined {
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,/i.exec(value)
  return match?.[1]?.toLowerCase()
}

/**
 * Map a user-message part. Text is `input_text`; an inline image is a base64
 * data URL; a `file-uri` image must be a fully qualified `http(s)` URL (the images
 * guide's "fully qualified URL"). File ids, documents and media resolution hints
 * are deferred and rejected. The media type was already checked against the
 * descriptor before mapping.
 */
function mapUserPart(part: Part, path: string): OpenAiInputContentPart {
  switch (part.kind) {
    case 'text':
      return { type: 'input_text', text: part.text }
    case 'inline-media': {
      if (part.mediaResolution !== undefined) {
        throw bad(
          `${path}.mediaResolution is not supported by @gullabs/openai in this release; remove it.`,
        )
      }
      if (!BASE64.test(part.data)) {
        throw bad(
          `${path}.data must be unwrapped base64 (no whitespace or data: prefix).`,
        )
      }
      return {
        type: 'input_image',
        image_url: `data:${part.mimeType};base64,${part.data}`,
        detail: 'auto',
      }
    }
    case 'file-uri': {
      if (part.mediaResolution !== undefined) {
        throw bad(
          `${path}.mediaResolution is not supported by @gullabs/openai in this release; remove it.`,
        )
      }
      if (httpUrl(part.uri) === undefined) {
        throw bad(
          `${path}.uri must be a fully qualified http(s) image URL; got "${bounded(part.uri)}".`,
        )
      }
      return { type: 'input_image', image_url: part.uri, detail: 'auto' }
    }
    case 'file-ref':
      throw bad(
        `${path}: file-ref parts (OpenAI file ids) are not supported by @gullabs/openai in this release.`,
      )
    case 'tool-call':
    case 'tool-result':
      throw bad(`${path}: ${part.kind} parts are handled by the request mapper.`)
    default:
      return assertNever(part)
  }
}

/**
 * The image count and inline payload limits of the images guide, over the whole
 * input (replayed state included).
 */
function assertImageLimits(input: readonly OpenAiRequestInputItem[]): void {
  let images = 0
  let inlineBytes = 0
  for (const item of input) {
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!isPlainRecord(part) || part['type'] !== 'input_image') continue
      images += 1
      const url = part['image_url']
      if (typeof url === 'string' && url.startsWith('data:')) inlineBytes += url.length
    }
  }
  if (images > OPENAI_MAX_IMAGES_PER_REQUEST) {
    throw bad(
      `The request carries ${images} images; OpenAI documents at most ${OPENAI_MAX_IMAGES_PER_REQUEST} per request.`,
    )
  }
  if (inlineBytes > OPENAI_MAX_INLINE_IMAGE_PAYLOAD_BYTES) {
    throw bad(
      `The request's inline images are ${inlineBytes} bytes of base64; OpenAI documents at most 512 MB of payload per request. Use public image URLs.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Replay state (ADR-029): validated against the wire items this release admits
// ---------------------------------------------------------------------------

/** Input-part checks shared by host messages and replayed state. */
function assertReplayInputPart(part: unknown, path: string): void {
  if (!isPlainRecord(part)) throw bad(`${path} must be an object.`)
  if (part['type'] === 'input_text') {
    if (typeof part['text'] !== 'string') throw bad(`${path}.text must be a string.`)
    return
  }
  if (part['type'] === 'input_image') {
    const url = part['image_url']
    if (typeof url !== 'string') throw bad(`${path}.image_url must be a string.`)
    const media = url.startsWith('data:') ? dataUrlMediaType(url) : undefined
    const admitted = url.startsWith('data:')
      ? media !== undefined && OPENAI_INPUT_MIME_TYPES.includes(media)
      : httpUrl(url) !== undefined
    if (!admitted) {
      throw bad(
        `${path}.image_url must be an http(s) URL or a base64 data URL of ${OPENAI_INPUT_MIME_TYPES.join(', ')}.`,
      )
    }
    if (part['detail'] !== 'auto') throw bad(`${path}.detail must be "auto".`)
    return
  }
  throw bad(
    `${path}.type "${String(part['type'])}" is not a content part @gullabs/openai sends in this release.`,
  )
}

/** Output-part checks for a replayed assistant `message` item. */
function assertReplayOutputPart(part: unknown, path: string): void {
  if (!isPlainRecord(part)) throw bad(`${path} must be an object.`)
  if (part['type'] === 'output_text' && typeof part['text'] === 'string') return
  if (part['type'] === 'refusal' && typeof part['refusal'] === 'string') return
  throw bad(
    `${path}.type "${String(part['type'])}" is not an output part @gullabs/openai admits in replay state.`,
  )
}

/**
 * One replayed item must be a shape this release itself produced: a user or
 * developer message of `input_text` / `input_image` parts, an assistant message
 * (history text, or a provider `message` item of `output_text` / `refusal`
 * parts), a `reasoning` item, a `function_call` or a `function_call_output`.
 * Anything else (a built-in tool call, a file input, a compaction item) would
 * bring a deferred feature back through the state and is rejected.
 */
function assertReplayItem(item: unknown, path: string): void {
  if (!isPlainRecord(item)) throw bad(`${path} must be an object.`)
  switch (item['type']) {
    case 'message': {
      const role = item['role']
      const content = item['content']
      if (role === 'user' || role === 'developer') {
        if (!Array.isArray(content)) throw bad(`${path}.content must be an array.`)
        content.forEach((part, i) => {
          assertReplayInputPart(part, `${path}.content[${i}]`)
        })
        return
      }
      if (role === 'assistant') {
        if (typeof content === 'string') return
        if (!Array.isArray(content)) {
          throw bad(`${path}.content must be a string or an array of output parts.`)
        }
        content.forEach((part, i) => {
          assertReplayOutputPart(part, `${path}.content[${i}]`)
        })
        return
      }
      throw bad(`${path}.role "${String(role)}" is not admitted in replay state.`)
    }
    case 'reasoning':
      if (!Array.isArray(item['summary'])) throw bad(`${path}.summary must be an array.`)
      return
    case 'function_call':
      if (
        typeof item['call_id'] !== 'string' ||
        typeof item['name'] !== 'string' ||
        typeof item['arguments'] !== 'string'
      ) {
        throw bad(`${path} must carry string call_id, name and arguments.`)
      }
      return
    case 'function_call_output':
      if (typeof item['call_id'] !== 'string' || typeof item['output'] !== 'string') {
        throw bad(`${path} must carry string call_id and output.`)
      }
      return
    default:
      throw bad(
        `${path}.type "${String(item['type'])}" is not an item @gullabs/openai admits in replay state (message, reasoning, function_call, function_call_output).`,
      )
  }
}

function parseReplayState(value: unknown, model: string): OpenAiReplayState | undefined {
  if (value === undefined) return undefined
  const keys = isPlainRecord(value) ? Object.keys(value) : []
  if (!isPlainRecord(value) || keys.length !== 1 || keys[0] !== 'openai') {
    throw bad(
      `transientProviderState must be exactly { openai: { model, input } } (got keys [${keys.join(', ')}]); another provider's state is rejected.`,
    )
  }
  const inner = value['openai']
  if (
    !isPlainRecord(inner) ||
    Object.keys(inner).some((key) => key !== 'model' && key !== 'input') ||
    inner['model'] !== model ||
    !Array.isArray(inner['input']) ||
    inner['input'].length === 0
  ) {
    throw bad(
      `transientProviderState must be { openai: { model, input } } with the full wire input of a prior result, bound to the requested model "${model}".`,
    )
  }
  inner['input'].forEach((item, i) => {
    assertReplayItem(item, `transientProviderState.openai.input[${i}]`)
  })
  return value as unknown as OpenAiReplayState
}

/** The text of a leading developer message, when the state starts with one. */
function leadingDeveloperText(
  input: readonly OpenAiRequestInputItem[],
): string | undefined {
  const first = input[0] as
    { type?: unknown; role?: unknown; content?: unknown } | undefined
  if (first?.type !== 'message' || first.role !== 'developer') return undefined
  if (!Array.isArray(first.content)) return undefined
  return first.content
    .map((part: unknown) =>
      isPlainRecord(part) && typeof part['text'] === 'string' ? part['text'] : '',
    )
    .join('')
}

// ---------------------------------------------------------------------------
// Usage (ADR-004 gross convention) and served tier
// ---------------------------------------------------------------------------

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * Map `Response.usage`. `input_tokens` is gross (it includes cache reads and
 * writes) and `output_tokens` includes reasoning. Cache writes and their TTL
 * split go to provider-local details; a missing read or write count marks the
 * usage incomplete, and the pricing source then leaves the call unpriced.
 */
function mapUsage(usage: OpenAiUsageShape, servedTier: string | undefined): Usage {
  const keys = OPENAI_USAGE_DETAIL_KEYS
  const inputDetails = isPlainRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : undefined
  const cached = inputDetails?.cached_tokens
  const writes = inputDetails?.cache_write_tokens
  const ttl = isPlainRecord(inputDetails?.cache_write_tokens_details)
    ? inputDetails.cache_write_tokens_details
    : undefined
  const reasoning = isPlainRecord(usage.output_tokens_details)
    ? usage.output_tokens_details.reasoning_tokens
    : undefined
  const details: Record<string, number> = {
    input: usage.input_tokens,
    output: usage.output_tokens,
  }
  if (isCount(cached)) details['cached'] = cached
  if (isCount(reasoning)) details['thinking'] = reasoning
  if (isCount(writes)) details[keys.cacheWrite] = writes
  if (ttl !== undefined) {
    if (isCount(ttl.ttl_30m_tokens)) details[keys.cacheWrite30m] = ttl.ttl_30m_tokens
    if (isCount(ttl.ttl_12h_tokens)) details[keys.cacheWrite12h] = ttl.ttl_12h_tokens
  }
  if (!isCount(cached) || !isCount(writes)) details[keys.usageIncomplete] = 1
  if (servedTier === undefined) details[keys.serviceTierMissing] = 1
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    details,
    raw: usage as unknown as JsonValue,
    ...(isCount(cached) ? { cachedInputTokens: cached } : {}),
    ...(isCount(reasoning) ? { thinkingTokens: reasoning } : {}),
    ...(isCount(usage.total_tokens) ? { totalTokens: usage.total_tokens } : {}),
  }
}

function hasTokenCounts(usage: unknown): usage is OpenAiUsageShape {
  return (
    isPlainRecord(usage) &&
    isCount(usage['input_tokens']) &&
    isCount(usage['output_tokens'])
  )
}

/** The echoed tier verbatim, or `undefined` when the response echoed none. */
function echoedTier(response: { service_tier?: unknown }): string | undefined {
  const tier = response.service_tier
  return typeof tier === 'string' && tier.length > 0 ? tier : undefined
}

/** Usage and served tier of a billed response, for a result or an error. */
function billing(response: OpenAiResponseShape): {
  usage?: Usage
  servedServiceTier?: string
} {
  const tier = echoedTier(response)
  return {
    ...(hasTokenCounts(response.usage) ? { usage: mapUsage(response.usage, tier) } : {}),
    ...(tier !== undefined ? { servedServiceTier: tier } : {}),
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * 429 `error.code` values that name a billing, spend or usage limit: "retrying
 * billing, spend, or quota errors won't restore access" (error-codes guide,
 * https://developers.openai.com/api/docs/guides/error-codes, read 2026-11-20).
 * `insufficient_quota` is the `error.type` the guide names for billing errors.
 */
const BILLING_LIMIT_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
])

/** The parsed error body's `code` and `type` (the SDK hoists them), never message text. */
function errorBodyCodes(raw: unknown): string[] {
  if (!isPlainRecord(raw) && !(raw instanceof Error)) return []
  const record = raw as unknown as Record<string, unknown>
  const body = isPlainRecord(record['error']) ? record['error'] : undefined
  return [record['code'], record['type'], body?.['code'], body?.['type']].filter(
    (value): value is string => typeof value === 'string',
  )
}

/** The SDK's own connection error, matched by class name (no runtime `openai` import here). */
function isSdkConnectionError(raw: unknown): boolean {
  return (
    raw instanceof Error &&
    (raw.constructor.name === 'APIConnectionError' ||
      raw.constructor.name === 'APIConnectionTimeoutError')
  )
}

/**
 * How a failed response's or an `error` event's code classifies (the SDK's
 * `ResponseError.code` union). Only `server_error` and `rate_limit_exceeded` name
 * a transient condition; an unrecognised code is not assumed transient.
 */
function classifyResponseCode(
  code: string | undefined,
): Pick<LlmError, 'kind' | 'retryable'> {
  switch (code) {
    case 'server_error':
      return { kind: 'server', retryable: true }
    case 'rate_limit_exceeded':
      return { kind: 'rate_limited', retryable: true }
    case 'bio_policy':
    case 'misalignment_policy_violation':
    case 'image_content_policy_violation':
      return { kind: 'content_filter', retryable: false }
    case 'invalid_prompt':
    case 'data_residency_mismatch':
    case 'invalid_image':
    case 'invalid_image_format':
    case 'invalid_base64_image':
    case 'invalid_image_url':
    case 'image_too_large':
    case 'image_too_small':
    case 'image_parse_error':
    case 'invalid_image_mode':
    case 'image_file_too_large':
    case 'unsupported_image_media_type':
    case 'empty_image_file':
    case 'failed_to_download_image':
    case 'image_file_not_found':
      return { kind: 'bad_request', retryable: false }
    default:
      return { kind: 'unknown', retryable: false }
  }
}

/**
 * Usage of a stream that failed after output began, as an ESTIMATE (ADR-040
 * Amendment A): wire input characters over 4, received output characters over
 * 4. Hidden reasoning is not counted and cached input is unknown, so it is the
 * order of magnitude of the spend, never a bill. The served tier is unknown, so
 * the pricing source leaves it unpriced.
 */
function estimatedUsage(outputChars: number, inputTokens: number): Usage {
  const outputTokens = Math.ceil(outputChars / 4)
  return {
    inputTokens,
    outputTokens,
    details: {
      input: inputTokens,
      output: outputTokens,
      [OPENAI_USAGE_DETAIL_KEYS.usageEstimated]: 1,
      [OPENAI_USAGE_DETAIL_KEYS.serviceTierMissing]: 1,
    },
    raw: {
      estimated: true,
      basis:
        'estimate: wire input characters / 4 for input (replayed state included, images not counted), received output characters / 4 for output; hidden reasoning is not counted',
      outputChars,
    },
  }
}

/** Input tokens of the request body as the failure estimate counts them. */
function estimateWireInputTokens(params: OpenAiResponseCreateParams): number {
  const withoutImageBytes = (key: string, value: unknown): unknown =>
    key === 'image_url' && typeof value === 'string' && value.startsWith('data:')
      ? ''
      : value
  const wire = JSON.stringify(
    { input: params.input, tools: params.tools, text: params.text },
    withoutImageBytes,
  )
  return Math.ceil(wire.length / 4)
}

/**
 * The error for a stream that did not reach a terminal event (ADR-040 rules).
 * Before any output event it is retryable where the failure is transient and
 * carries no usage. After output began it is never retryable, is
 * `mayHaveBilled`, and carries the usage estimate.
 */
function classifyStreamError(
  err: OpenAiStreamError,
  estimatedInputTokens: number,
  requestTimeoutMs: number,
): LlmError {
  const { progressed, outputChars } = err.progress
  const common = {
    provider: 'openai',
    ...(progressed
      ? { usage: estimatedUsage(outputChars, estimatedInputTokens), mayHaveBilled: true }
      : {}),
    cause: err,
  } as const
  const failure = err.failure
  switch (failure.kind) {
    case 'ended_early':
      return new LlmError(err.message, {
        kind: 'server',
        retryable: !progressed,
        ...common,
      })
    case 'cut': {
      const base = classifyOpenAiError(err.cause)
      return base.kind === 'timeout'
        ? new LlmError(base.message, {
            kind: 'timeout',
            retryable: false,
            ...(base.reason !== undefined ? { reason: base.reason } : {}),
            ...common,
          })
        : new LlmError(err.message, { kind: 'server', retryable: false, ...common })
    }
    case 'deadline':
      return new LlmError(
        `OpenAI request hit the client deadline: the stream was still open after the ${requestTimeoutMs} ms request timeout`,
        { kind: 'timeout', retryable: false, reason: 'transport_timeout', ...common },
      )
    case 'aborted': {
      const reason: unknown = err.cause
      return reason instanceof LlmError
        ? new LlmError(reason.message, {
            kind: reason.kind,
            retryable: reason.retryable,
            ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
            ...common,
            cause: reason,
          })
        : new LlmError('Request aborted by caller', {
            kind: 'aborted',
            retryable: false,
            ...common,
            cause: reason ?? err,
          })
    }
    case 'error_event': {
      const mapped = classifyResponseCode(failure.code)
      // The stream had started: the call is never known-free, and inside an open
      // stream only a server error before any output is retried.
      return new LlmError(err.message, {
        kind: mapped.kind,
        retryable: mapped.kind === 'server' && !progressed,
        ...common,
        mayHaveBilled: true,
      })
    }
    default:
      return assertNever(failure)
  }
}

/**
 * Classify a raw error from the OpenAI call into a typed {@link LlmError}.
 *
 * 1. An {@link LlmError} is returned unchanged.
 * 2. A stream failure follows {@link classifyStreamError}.
 * 3. Core's `classifyError` gives the HTTP classification (401/403
 *    `invalid_auth`, 404/400/422 `bad_request`, 429 `rate_limited` retryable with
 *    `Retry-After` read from the SDK error's headers, 5xx retryable `server`).
 * 4. A 429 whose structured body names a billing, spend or usage limit is
 *    `rate_limited`, not retryable, `reason: 'credits_exhausted'`.
 * 5. An SDK connection error core left `unknown` is a retryable `server` error.
 *
 * Structured fields only; free-form message text never changes the class.
 */
export function classifyOpenAiError(
  raw: unknown,
  estimatedInputTokens = 0,
  requestTimeoutMs = OPENAI_DEFAULT_TIMEOUT_MS,
): LlmError {
  if (raw instanceof LlmError) return raw
  if (raw instanceof OpenAiStreamError) {
    return classifyStreamError(raw, estimatedInputTokens, requestTimeoutMs)
  }
  const base = classifyError(raw)
  const common = {
    ...(base.httpStatus !== undefined ? { httpStatus: base.httpStatus } : {}),
    provider: 'openai',
    cause: base.cause ?? raw,
  }
  if (
    base.httpStatus === 429 &&
    errorBodyCodes(raw).some((c) => BILLING_LIMIT_CODES.has(c))
  ) {
    return new LlmError(base.message, {
      kind: 'rate_limited',
      retryable: false,
      reason: 'credits_exhausted',
      ...common,
    })
  }
  if (base.kind === 'unknown' && isSdkConnectionError(raw)) {
    return new LlmError(base.message, { kind: 'server', retryable: true, ...common })
  }
  return new LlmError(base.message, {
    kind: base.kind,
    retryable: base.retryable,
    ...(base.retryAfterMs !== undefined ? { retryAfterMs: base.retryAfterMs } : {}),
    ...(base.reason !== undefined ? { reason: base.reason } : {}),
    ...common,
  })
}

/**
 * The error for a terminal `response.failed`: classified by `error.code`, never
 * retried once output events arrived, always `mayHaveBilled`, with the billed
 * usage and the echoed tier when the response reports them.
 */
function failedResponseError(
  response: OpenAiResponseShape,
  streamProgressed: boolean,
): LlmError {
  const reported = isPlainRecord(response.error) ? response.error : undefined
  const code = typeof reported?.['code'] === 'string' ? reported['code'] : undefined
  const detail =
    typeof reported?.['message'] === 'string' ? `: ${reported['message']}` : ''
  const { kind, retryable } = classifyResponseCode(code)
  return new LlmError(
    `OpenAI response failed${code !== undefined ? ` (error.code "${code}")` : ''}${detail}`,
    {
      kind,
      retryable: retryable && !streamProgressed,
      mayHaveBilled: true,
      provider: 'openai',
      ...billing(response),
      cause: response.error ?? { status: response.status },
    },
  )
}

// ---------------------------------------------------------------------------
// Finish reason
// ---------------------------------------------------------------------------

/**
 * `completed` is `stop`. `incomplete` with `incomplete_details.reason`
 * `max_output_tokens` is `length`, `content_filter` is `content_filter` (both
 * in the SDK's `IncompleteDetails.reason` union); any other reason is `other`.
 */
function mapFinishReason(response: OpenAiResponseShape): FinishReason {
  if (response.status === 'completed') return 'stop'
  const reason = response.incomplete_details?.reason
  if (response.status === 'incomplete' && reason === 'max_output_tokens') return 'length'
  if (response.status === 'incomplete' && reason === 'content_filter') {
    return 'content_filter'
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenAiAdapterOptions {
  /**
   * Inject a pre-built structural client (a test double, or a runtime smoke).
   * When omitted, the adapter builds the real SDK client from `ctx.auth` on
   * every call, inside the classified try/catch.
   */
  client?: OpenAiClientLike
}

/**
 * Create the OpenAI provider adapter (Responses API).
 *
 * @param opts.client - Optional pre-built structural client.
 */
export function openaiAdapter(opts?: OpenAiAdapterOptions): ProviderAdapter {
  return openaiAdapterWithSeams(opts, {})
}

/**
 * Test seams of {@link openaiAdapter}: the client factory and the `fetch` the
 * real SDK client uses. Not exported from the package index.
 *
 * @internal
 */
interface OpenAiAdapterSeams {
  clientFactory?: (auth: AuthMaterial) => OpenAiClientLike | Promise<OpenAiClientLike>
  fetch?: typeof fetch
}

/** @internal */
export function openaiAdapterWithSeams(
  opts: OpenAiAdapterOptions | undefined,
  seams: OpenAiAdapterSeams,
): ProviderAdapter {
  return {
    id: 'openai',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      if (req.provider !== 'openai') {
        throw bad(`openaiAdapter received a request for provider "${req.provider}".`)
      }
      const model = req.model
      if (req.modelDescriptor !== undefined) {
        assertModelMatchesDescriptor(req, req.modelDescriptor, 'openai')
      }
      const descriptor = req.modelDescriptor
      const capabilities = descriptor?.capabilities
      // Every registered model continues with state; a request without a
      // matching descriptor would lose the replay contract, so it is refused.
      if (
        descriptor === undefined ||
        openaiRegistry.resolve('openai', model) === undefined ||
        capabilities?.continuation !== 'state' ||
        capabilities.providerState !== true
      ) {
        throw bad(
          `A registered OpenAI model descriptor with continuation "state" is required for "${model}".`,
        )
      }
      assertInputMimeTypesAdmitted(req.messages, descriptor, 'openai')
      const config = req.config
      const warnings: Warning[] = []

      // ----------------------------------------------------------------
      // 1. Unsupported config (the strict schema rejects these first; the
      //    adapter refuses them too for a direct call).
      // ----------------------------------------------------------------
      for (const key of ['temperature', 'topP', 'topK', 'stopSequences'] as const) {
        if (config[key] !== undefined) {
          throw bad(`config.${key} is not supported for OpenAI model "${model}".`)
        }
      }
      if (config.providerOptions !== undefined) {
        throw bad(
          `config.providerOptions is not supported by @gullabs/openai in this release (model "${model}").`,
        )
      }

      // ----------------------------------------------------------------
      // 2. Input: replayed state, then the new messages.
      // ----------------------------------------------------------------
      const replay = parseReplayState(req.transientProviderState, model)
      if (replay !== undefined && req.messages.length === 0) {
        throw bad(
          `Stateless replay for model "${model}" requires new messages to append to the state.`,
        )
      }
      const input: OpenAiRequestInputItem[] = []
      if (replay !== undefined) {
        input.push(...replay.openai.input)
        if (req.system !== undefined && req.system !== leadingDeveloperText(input)) {
          throw bad(
            `system must equal the developer message the replay state starts with for model "${model}" (it is replayed from the state, never sent twice).`,
          )
        }
      } else if (req.system !== undefined) {
        // A leading developer message, not top-level `instructions` ("Top-level
        // instructions are appended after input. To make stable instructions
        // cacheable, place them in a developer message as the first item in
        // input": https://developers.openai.com/api/docs/guides/latest-model).
        input.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: req.system }],
        })
      }
      const isItem = (type: string) => (item: OpenAiRequestInputItem) =>
        (item as { type?: unknown }).type === type
      const callIds = (type: string): Set<string> =>
        new Set(
          input
            .filter(isItem(type))
            .map((item) => (item as { call_id?: unknown }).call_id)
            .filter((id): id is string => typeof id === 'string'),
        )
      const stateCalls = callIds('function_call')
      const answered = callIds('function_call_output')

      req.messages.forEach((message: Message, m) => {
        const where = `messages[${m}]`
        if (message.role === 'assistant') {
          if (replay !== undefined) {
            throw bad(
              `${where}: new messages for model "${model}" cannot contain assistant history when transientProviderState is supplied; the state already holds it.`,
            )
          }
          const text: string[] = []
          message.parts.forEach((part, p) => {
            if (part.kind === 'tool-call') {
              throw bad(
                `${where}.parts[${p}]: function-call history for model "${model}" requires transientProviderState from the prior result.`,
              )
            }
            if (part.kind !== 'text') {
              throw bad(
                `${where}.parts[${p}]: an assistant history message for OpenAI carries text only (got ${part.kind}).`,
              )
            }
            text.push(part.text)
          })
          if (text.length > 0) {
            input.push({ type: 'message', role: 'assistant', content: text.join('') })
          }
          return
        }
        const content: OpenAiInputContentPart[] = []
        const flush = (): void => {
          if (content.length > 0) {
            input.push({ type: 'message', role: 'user', content: content.splice(0) })
          }
        }
        message.parts.forEach((part, p) => {
          if (part.kind === 'tool-result') {
            if (replay === undefined) {
              throw bad(
                `${where}.parts[${p}]: a tool result for model "${model}" requires transientProviderState from the result that made the call.`,
              )
            }
            if (!stateCalls.has(part.toolCallId) || answered.has(part.toolCallId)) {
              throw bad(
                `${where}.parts[${p}]: tool result "${part.toolCallId}" must answer an unanswered function call in transientProviderState.`,
              )
            }
            answered.add(part.toolCallId)
            flush()
            input.push({
              type: 'function_call_output',
              call_id: part.toolCallId,
              output: JSON.stringify(part.result),
            })
            return
          }
          content.push(mapUserPart(part, `${where}.parts[${p}]`))
        })
        flush()
      })
      assertImageLimits(input)

      // ----------------------------------------------------------------
      // 3. Request params.
      // ----------------------------------------------------------------
      const params: OpenAiResponseCreateParams = { model, input, store: false }
      if (config.maxOutputTokens !== undefined) {
        params.max_output_tokens = config.maxOutputTokens
      }
      if (config.serviceTier !== undefined) {
        const tier = config.serviceTier
        if (
          !(capabilities.serviceTiers ?? []).includes(tier) ||
          (tier !== 'flex' && tier !== 'fast')
        ) {
          throw bad(`serviceTier "${tier}" is not supported for OpenAI model "${model}".`)
        }
        params.service_tier = tier
      }
      const reasoning = config.reasoning
      if (reasoning !== undefined) {
        if (reasoning.budgetTokens !== undefined) {
          throw bad(
            `reasoning.budgetTokens is not supported for model "${model}"; OpenAI uses reasoning.effort.`,
          )
        }
        if (reasoning.includeThoughts !== undefined) {
          throw bad(
            `reasoning.includeThoughts is not supported by @gullabs/openai in this release (model "${model}").`,
          )
        }
        if (reasoning.effort !== undefined) {
          if (!(capabilities.admittedReasoningEfforts ?? []).includes(reasoning.effort)) {
            throw bad(
              `reasoning.effort "${reasoning.effort}" is not supported for OpenAI model "${model}".`,
            )
          }
          // `reasoning.context` is not sent: omitting it takes the model default,
          // which no page states for GPT-6.x (ADR-047).
          params.reasoning = { effort: reasoning.effort }
        }
      }

      const tools = req.tools ?? []
      if (req.outputJsonSchema !== undefined && tools.length > 0) {
        // `structuredOutputWithTools: false` on every descriptor: no page
        // documents the combination for these models.
        throw bad(
          `Structured output together with function tools is not supported for OpenAI model "${model}".`,
        )
      }
      if (req.outputJsonSchema !== undefined) {
        const schema = req.outputJsonSchema
        assertOpenAiStrictSchema(schema, 'output.jsonSchema')
        const title = isPlainRecord(schema) ? schema['title'] : undefined
        if (typeof title === 'string' && !SCHEMA_NAME.test(title)) {
          throw bad(
            `output.jsonSchema.title "${bounded(title)}" cannot be the structured-output name for model "${model}": it must match ${SCHEMA_NAME.source}. Rename it or remove it to use "${DEFAULT_SCHEMA_NAME}".`,
          )
        }
        params.text = {
          format: {
            type: 'json_schema',
            name: typeof title === 'string' ? title : DEFAULT_SCHEMA_NAME,
            schema,
            strict: true,
          },
        }
      }
      if (tools.length > 0) {
        if (capabilities.functionCalling !== true) {
          throw bad(`tools are not supported for OpenAI model "${model}".`)
        }
        params.tools = tools.map((tool, index): OpenAiFunctionTool => {
          assertOpenAiStrictSchema(
            tool.inputJsonSchema,
            `tools[${index}].inputJsonSchema`,
          )
          return {
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputJsonSchema,
            strict: true,
          }
        })
        // `parallel_tool_calls` is not sent: per-model support is not documented.
        if (req.toolChoice !== undefined) {
          params.tool_choice =
            typeof req.toolChoice === 'string'
              ? req.toolChoice
              : { type: 'function', name: req.toolChoice.name }
        }
      } else if (req.toolChoice !== undefined) {
        throw bad(`toolChoice requires tools for OpenAI model "${model}".`)
      }

      // ----------------------------------------------------------------
      // 4. Dispatch.
      // ----------------------------------------------------------------
      let response: OpenAiResponseShape
      let meta: OpenAiResponseMeta | undefined
      const requestTimeoutMs = config.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS
      try {
        const client: OpenAiClientLike =
          opts?.client ??
          (await (
            seams.clientFactory ?? ((auth) => buildOpenAiClient(auth, seams.fetch))
          )(ctx.auth))
        ctx.logger.debug(
          { model, configKeys: Object.keys(params) },
          'llm.adapter.dispatch',
        )
        response = await client.responses.create(params, {
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          timeout:
            config.timeoutMs !== undefined
              ? config.timeoutMs + OPENAI_TIMEOUT_BUFFER_MS
              : OPENAI_DEFAULT_TIMEOUT_MS,
          onResponse: (m) => {
            meta = m
          },
        })
      } catch (raw) {
        throw classifyOpenAiError(raw, estimateWireInputTokens(params), requestTimeoutMs)
      }

      // ----------------------------------------------------------------
      // 5. Terminal outcome.
      // ----------------------------------------------------------------
      if (response.status === 'failed') {
        throw failedResponseError(response, meta?.streamProgressed === true)
      }
      if (!hasTokenCounts(response.usage)) {
        throw new LlmError(
          `OpenAI response ${String(response.id)} (status "${String(response.status)}") carries no numeric usage; it cannot be priced.`,
          {
            kind: 'server',
            retryable: false,
            mayHaveBilled: true,
            provider: 'openai',
            cause: { id: response.id },
          },
        )
      }
      const billed = billing(response)
      const usage = billed.usage as Usage
      if (billed.servedServiceTier === undefined) {
        warnings.push({
          type: 'other',
          message: `openai: the response did not echo service_tier${
            params.service_tier !== undefined
              ? ` (requested "${params.service_tier}")`
              : ''
          }; the served tier is unknown and the call is unpriced.`,
        })
      }

      try {
        return mapResult(
          response,
          params,
          usage,
          billed.servedServiceTier,
          meta,
          warnings,
          model,
        )
      } catch (mapErr) {
        if (mapErr instanceof LlmError) throw mapErr
        throw new LlmError(
          `OpenAI response ${String(response.id)} could not be mapped: ${
            mapErr instanceof Error ? mapErr.message : String(mapErr)
          }`,
          {
            kind: 'server',
            retryable: false,
            mayHaveBilled: true,
            provider: 'openai',
            ...billed,
            cause: mapErr,
          },
        )
      }
    },
  }
}

const ADMITTED_OUTPUT_TYPES = new Set(['message', 'reasoning', 'function_call'])

/** Map a completed or incomplete response into the result (ADR-029 ordering). */
function mapResult(
  response: OpenAiResponseShape,
  params: OpenAiResponseCreateParams,
  usage: Usage,
  servedServiceTier: string | undefined,
  meta: OpenAiResponseMeta | undefined,
  warnings: Warning[],
  model: string,
): AdapterResult {
  const output = Array.isArray(response.output) ? response.output : []
  const parts: Part[] = []
  const toolCalls: NonNullable<AdapterResult['toolCalls']> = []
  const dropped: string[] = []
  const droppedItems = new Set<OpenAiOutputItem>()
  let text = ''
  let lastMessageText = ''
  let refusal: string | undefined
  const unexpected = new Map<string, number>()

  for (const item of output) {
    if (item.type === 'message') {
      const content = Array.isArray(item['content']) ? (item['content'] as unknown[]) : []
      let itemText = ''
      for (const part of content) {
        if (!isPlainRecord(part)) continue
        if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
          itemText += part['text']
        } else if (part['type'] === 'refusal') {
          const said = typeof part['refusal'] === 'string' ? part['refusal'] : ''
          refusal = refusal === undefined ? said : `${refusal} ${said}`
        } else {
          const type = typeof part['type'] === 'string' ? part['type'] : 'unknown'
          unexpected.set(
            `message part ${type}`,
            (unexpected.get(`message part ${type}`) ?? 0) + 1,
          )
        }
      }
      lastMessageText = itemText
      if (itemText.length > 0) {
        text += itemText
        parts.push({ kind: 'text', text: itemText })
      }
    } else if (item.type === 'function_call') {
      const callId = typeof item['call_id'] === 'string' ? item['call_id'] : ''
      const name = typeof item['name'] === 'string' ? item['name'] : ''
      // A call of a response that did not complete, or one not itself completed,
      // is not a call to run (ADR-040 Amendment B item 6).
      if (
        response.status !== 'completed' ||
        (typeof item['status'] === 'string' && item['status'] !== 'completed') ||
        callId === '' ||
        name === ''
      ) {
        dropped.push(name !== '' ? name : callId)
        droppedItems.add(item)
        continue
      }
      let args: JsonValue
      try {
        args = JSON.parse(
          typeof item['arguments'] === 'string' ? item['arguments'] : '',
        ) as JsonValue
      } catch (cause) {
        throw new LlmError(
          `OpenAI response ${response.id} holds a completed function call "${name}" whose arguments are not valid JSON.`,
          {
            kind: 'server',
            retryable: false,
            mayHaveBilled: true,
            provider: 'openai',
            usage,
            ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
            cause,
          },
        )
      }
      const call = { toolCallId: callId, toolName: name, args }
      toolCalls.push(call)
      parts.push({ kind: 'tool-call', ...call })
    } else if (!ADMITTED_OUTPUT_TYPES.has(item.type)) {
      unexpected.set(item.type, (unexpected.get(item.type) ?? 0) + 1)
    }
  }

  for (const [what, count] of unexpected) {
    warnings.push({
      type: 'other',
      message: `openai: ignored ${count} output ${what} item(s) this release does not map; they stay in the replay state, which the next request rejects.`,
    })
  }

  let finishReason = mapFinishReason(response)
  if (response.status === 'incomplete' && finishReason === 'other') {
    warnings.push({
      type: 'other',
      message: `openai: the response is incomplete (reason "${String(
        response.incomplete_details?.reason ?? 'unknown',
      )}"); finishReason is "other".`,
    })
  }
  if (refusal !== undefined) {
    if (finishReason !== 'length') finishReason = 'content_filter'
    warnings.push({
      type: 'other',
      message: `openai: the model refused to answer${
        refusal.length > 0 ? `: "${bounded(refusal)}"` : ''
      }; finishReason is "${finishReason}".`,
    })
  }
  if (dropped.length > 0) {
    warnings.push({
      type: 'other',
      message: `openai: dropped ${dropped.length} function call(s) (${dropped
        .map((n) => `"${n}"`)
        .join(
          ', ',
        )}) because the response ended with status "${response.status}" or the call did not complete; the result carries no tool call for them.`,
    })
  }

  let rawStructured: unknown
  // The structured answer is the last message item (an earlier one, if any, is
  // not the final answer).
  if (params.text !== undefined && lastMessageText.length > 0) {
    try {
      rawStructured = JSON.parse(lastMessageText)
    } catch {
      // Core reports an unparsed answer by the absence of rawStructured (ADR-009).
    }
  }

  const state: OpenAiReplayState = {
    openai: {
      model,
      input: [...params.input, ...output.filter((item) => !droppedItems.has(item))],
    },
  }

  return {
    model: typeof response.model === 'string' ? response.model : model,
    message: { role: 'assistant', parts },
    usage,
    warnings,
    finishReason,
    responseId: response.id,
    transientProviderState: state as unknown as JsonValue,
    ...(text.length > 0 ? { text } : {}),
    ...(rawStructured !== undefined ? { rawStructured } : {}),
    ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
    ...(meta?.requestId !== undefined
      ? { providerMetadata: { openai: { requestId: meta.requestId } } }
      : {}),
    ...(toolCalls.length > 0 ? { toolCalls, finishReason: 'tool_calls' as const } : {}),
  }
}
