/**
 * xaiAdapter — @gullabs/xai xAI Grok provider adapter.
 *
 * Pure request⇄response mapping over the xAI Responses API (via
 * XaiClientLike). Never persists, never computes cost, never loops.
 *
 * @module
 */

import {
  LlmError,
  classifyError,
  causeChain,
  assertNever,
  assertJsonSchemaProfile,
  assertInputMimeTypesAdmitted,
  assertModelMatchesDescriptor,
} from '@gullabs/core'
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
  Citation,
  TokenCountRequest,
  TokenCount,
} from '@gullabs/core'
import {
  buildXaiClient,
  requireApiKey,
  XAI_DEFAULT_TIMEOUT_MS,
  XAI_RESERVED_FETCH_OPTION_KEYS,
  XAI_TIMEOUT_BUFFER_MS,
} from './client.js'
import { xaiRegistry } from './models.js'
import { XAI_JSON_SCHEMA_PROFILE } from './json-schema.js'
import { X_SEARCH_ITEM_COUNTERS, unpricedXaiToolCounters } from './pricing.js'
import type {
  XaiClientLike,
  XaiRequestOptions,
  XaiResponseMeta,
  XaiTransport,
  XaiResponseCreateParams,
  XaiInputContentPart,
  XaiRequestInputItem,
  XaiResponseShape,
  XaiUsageShape,
  XaiMessageOutputItem,
  XaiReasoningOutputItem,
  XaiReplayState,
} from './client.js'

// ---------------------------------------------------------------------------
// Small object-shape helpers (mirrors google adapter's local helpers)
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isXaiMessageItem(
  item: XaiResponseShape['output'][number],
): item is XaiMessageOutputItem {
  return item.type === 'message' && Array.isArray((item as XaiMessageOutputItem).content)
}

function isXaiReasoningItem(
  item: XaiResponseShape['output'][number],
): item is XaiReasoningOutputItem {
  return (
    item.type === 'reasoning' && Array.isArray((item as { summary?: unknown }).summary)
  )
}

function badXaiRequest(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false })
}

// ---------------------------------------------------------------------------
// Vision / media mapping
// ---------------------------------------------------------------------------

/** 20 MiB, xAI's documented inline-image size ceiling. */
const MAX_XAI_INLINE_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Map a single {@link Part} to its xAI Responses API input-content-part
 * equivalent.
 *
 * - `text`         → `{ type: 'input_text', text }`
 * - `inline-media` → `{ type: 'input_image', image_url: 'data:<mime>;base64,<data>' }`;
 *   rejected (`bad_request`) when the decoded payload exceeds 20 MiB. The
 *   media type itself is checked against the descriptor's
 *   `capabilities.inputMimeTypes` (jpeg and png; WebP is not accepted) before
 *   any part is mapped.
 * - `file-uri`     → `{ type: 'input_image', image_url: uri }` ONLY when
 *   `uri` is a public `http(s)://` URL (its media type is checked like an
 *   inline part's) — a provider-hosted URI from another provider (e.g. Gemini's Files
 *   API `https://generativelanguage.googleapis.com/...` — which itself
 *   happens to be `https://`, but is not dereferenceable by xAI) is not
 *   portable and callers should not reuse `FileUriPart` cross-provider.
 * - `file-ref`     → `{ type: 'input_file', file_id }` for xAI Files uploads.
 *   Attaching files implicitly enables xAI's `attachment_search` agentic tool
 *   (extra tool billing may apply). Empty `fileId` → `bad_request`.
 *
 * Note: xAI enforces an undocumented server-side minimum image size
 * (observed ~8px/side, ~512 total px). This adapter does not pre-validate
 * pixel dimensions — a too-small image surfaces as a `bad_request` from the
 * live API, classified normally by {@link classifyXaiError}.
 */
function mapPart(p: Part): XaiInputContentPart {
  switch (p.kind) {
    case 'text':
      return { type: 'input_text', text: p.text }

    case 'inline-media': {
      const byteLength = Buffer.from(p.data, 'base64').length
      if (byteLength > MAX_XAI_INLINE_IMAGE_BYTES) {
        throw badXaiRequest(
          `xAI inline images must be at most 20 MiB; got ${byteLength} bytes.`,
        )
      }
      return { type: 'input_image', image_url: `data:${p.mimeType};base64,${p.data}` }
    }

    case 'file-uri': {
      const isPublicHttpUrl = p.uri.startsWith('http://') || p.uri.startsWith('https://')
      if (!isPublicHttpUrl) {
        throw badXaiRequest(
          `xAI only accepts public http(s) image URLs via FileUriPart; got scheme of "${p.uri}" / mimeType "${p.mimeType}".`,
        )
      }
      // Reject known foreign provider hosts even when scheme+mime look valid.
      if (
        p.uri.includes('generativelanguage.googleapis.com') ||
        p.uri.includes('googleapis.com/v1beta/files')
      ) {
        throw badXaiRequest(
          `xAI cannot dereference Gemini/Google Files URIs via FileUriPart; upload to xAI Files and use FileRefPart (file_id) instead. Got "${p.uri}".`,
        )
      }
      return { type: 'input_image', image_url: p.uri }
    }

    case 'file-ref': {
      if (typeof p.fileId !== 'string' || p.fileId.trim() === '') {
        throw badXaiRequest('FileRefPart.fileId must be a non-empty string.')
      }
      return { type: 'input_file', file_id: p.fileId }
    }

    case 'tool-call':
    case 'tool-result':
      throw badXaiRequest(
        `xAI mapPart does not emit ${p.kind} as a content part; the request mapper handles replay items.`,
      )

    default:
      return assertNever(p)
  }
}

// ---------------------------------------------------------------------------
// providerOptions.xai → explicit allowlisted mapping
// ---------------------------------------------------------------------------

const XAI_PROVIDER_OPTION_KEYS = new Set([
  'promptCacheKey',
  'tools',
  'parallelToolCalls',
  'toolChoice',
  'maxTurns',
  'searchBudget',
])

const XAI_SERVER_TOOL_CHOICES = new Set(['auto', 'required', 'none'])

type MappedXaiProviderOptions = {
  promptCacheKey?: string
  tools?: Array<Record<string, unknown>>
  parallelToolCalls?: boolean
  toolChoice?: 'auto' | 'required' | 'none'
  maxTurns?: number
  /** Observed after the call, never sent to xAI. */
  searchBudget?: XaiSearchBudget
}

/**
 * `providerOptions.xai.searchBudget`: ceilings the adapter compares with the
 * search counters xAI reports after the call. xAI offers no per-call ceiling
 * on search volume (`maxTurns` is not enforced), so this only tells the host
 * the call exceeded what it expected to pay for.
 */
type XaiSearchBudget = { maxWebSearchCalls?: number; maxXItems?: number }

const XAI_SEARCH_BUDGET_KEYS = ['maxWebSearchCalls', 'maxXItems'] as const

function mapXaiSearchBudget(
  value: unknown,
  tools: Array<Record<string, unknown>> | undefined,
  model: string,
): XaiSearchBudget {
  if (!isPlainRecord(value)) {
    throw badXaiRequest(
      `providerOptions.xai.searchBudget must be an object for model "${model}".`,
    )
  }
  const unknown = Object.keys(value).filter(
    (key) => !(XAI_SEARCH_BUDGET_KEYS as readonly string[]).includes(key),
  )
  if (unknown.length > 0) {
    throw badXaiRequest(
      `providerOptions.xai.searchBudget contains unsupported keys [${unknown.join(
        ', ',
      )}] for model "${model}". Allowed keys: ${XAI_SEARCH_BUDGET_KEYS.join(', ')}.`,
    )
  }
  const budget: XaiSearchBudget = {}
  for (const key of XAI_SEARCH_BUDGET_KEYS) {
    const entry = value[key]
    if (entry === undefined) continue
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) {
      throw badXaiRequest(
        `providerOptions.xai.searchBudget.${key} must be an integer >= 1 for model "${model}".`,
      )
    }
    budget[key] = entry
  }
  if (budget.maxWebSearchCalls === undefined && budget.maxXItems === undefined) {
    throw badXaiRequest(
      `providerOptions.xai.searchBudget must set maxWebSearchCalls or maxXItems for model "${model}".`,
    )
  }
  const hasTool = (type: string): boolean =>
    tools?.some((tool) => tool['type'] === type) === true
  if (budget.maxWebSearchCalls !== undefined && !hasTool('web_search')) {
    throw badXaiRequest(
      `providerOptions.xai.searchBudget.maxWebSearchCalls requires a web_search tool in providerOptions.xai.tools for model "${model}".`,
    )
  }
  if (budget.maxXItems !== undefined && !hasTool('x_search')) {
    throw badXaiRequest(
      `providerOptions.xai.searchBudget.maxXItems requires an x_search tool in providerOptions.xai.tools for model "${model}".`,
    )
  }
  return budget
}

/**
 * Names the budget lines the observed counters exceed. A counter xAI did not
 * report cannot be compared, so it never counts as exceeded.
 */
function exceededSearchBudget(
  budget: XaiSearchBudget,
  details: Record<string, number>,
): string[] {
  const over: string[] = []
  const webCalls = details[WEB_SEARCH_COUNTER]
  if (
    budget.maxWebSearchCalls !== undefined &&
    webCalls !== undefined &&
    webCalls > budget.maxWebSearchCalls
  ) {
    over.push(
      `${WEB_SEARCH_COUNTER} ${webCalls} > maxWebSearchCalls ${budget.maxWebSearchCalls}`,
    )
  }
  if (budget.maxXItems !== undefined) {
    const reported = X_SEARCH_ITEM_COUNTERS.filter((key) => details[key] !== undefined)
    const items = reported.reduce((sum, key) => sum + (details[key] as number), 0)
    if (reported.length > 0 && items > budget.maxXItems) {
      over.push(`X items ${items} > maxXItems ${budget.maxXItems}`)
    }
  }
  return over
}

function mapXaiProviderOptions(
  xaiOpts: unknown,
  model: string,
): MappedXaiProviderOptions {
  if (xaiOpts === undefined) {
    return {}
  }

  if (!isPlainRecord(xaiOpts)) {
    throw badXaiRequest(`providerOptions.xai must be an object for model "${model}".`)
  }

  const unknownKeys = Object.keys(xaiOpts).filter(
    (key) => !XAI_PROVIDER_OPTION_KEYS.has(key),
  )
  if (unknownKeys.length > 0) {
    throw badXaiRequest(
      `providerOptions.xai contains unsupported keys [${unknownKeys.join(
        ', ',
      )}] for model "${model}". Allowed keys: promptCacheKey, tools, parallelToolCalls, toolChoice, maxTurns, searchBudget.`,
    )
  }

  const mapped: MappedXaiProviderOptions = {}
  if (xaiOpts['promptCacheKey'] !== undefined) {
    if (
      typeof xaiOpts['promptCacheKey'] !== 'string' ||
      xaiOpts['promptCacheKey'].length === 0
    ) {
      throw badXaiRequest(
        `providerOptions.xai.promptCacheKey must be a non-empty string for model "${model}".`,
      )
    }
    mapped.promptCacheKey = xaiOpts['promptCacheKey']
  }

  if (xaiOpts['tools'] !== undefined) {
    mapped.tools = mapXaiSearchTools(xaiOpts['tools'], model)
  }

  if (xaiOpts['parallelToolCalls'] !== undefined) {
    if (typeof xaiOpts['parallelToolCalls'] !== 'boolean') {
      throw badXaiRequest(
        `providerOptions.xai.parallelToolCalls must be a boolean for model "${model}".`,
      )
    }
    mapped.parallelToolCalls = xaiOpts['parallelToolCalls']
  }

  const toolChoice = xaiOpts['toolChoice']
  if (toolChoice !== undefined) {
    if (typeof toolChoice !== 'string' || !XAI_SERVER_TOOL_CHOICES.has(toolChoice)) {
      throw badXaiRequest(
        `providerOptions.xai.toolChoice must be "auto", "required" or "none" for model "${model}".`,
      )
    }
    if (mapped.tools === undefined || mapped.tools.length === 0) {
      throw badXaiRequest(
        `providerOptions.xai.toolChoice requires a non-empty providerOptions.xai.tools for model "${model}".`,
      )
    }
    mapped.toolChoice = toolChoice as 'auto' | 'required' | 'none'
  }

  const maxTurns = xaiOpts['maxTurns']
  if (maxTurns !== undefined) {
    if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns) || maxTurns < 1) {
      throw badXaiRequest(
        `providerOptions.xai.maxTurns must be an integer >= 1 for model "${model}".`,
      )
    }
    if (mapped.tools === undefined || mapped.tools.length === 0) {
      throw badXaiRequest(
        `providerOptions.xai.maxTurns requires a non-empty providerOptions.xai.tools for model "${model}".`,
      )
    }
    mapped.maxTurns = maxTurns
  }

  if (xaiOpts['searchBudget'] !== undefined) {
    mapped.searchBudget = mapXaiSearchBudget(xaiOpts['searchBudget'], mapped.tools, model)
  }

  return mapped
}

function parseXaiReplayState(value: unknown, model: string): XaiReplayState | undefined {
  if (value === undefined) return undefined
  const keys = isPlainRecord(value) ? Object.keys(value) : []
  if (keys.some((key) => key !== 'xai')) {
    throw badXaiRequest(
      `transientProviderState has unexpected key(s) [${keys.join(', ')}]; xAI state is exactly { xai: { model, input } } (another provider's state is rejected).`,
    )
  }
  const inner = isPlainRecord(value) ? value['xai'] : undefined
  if (
    !isPlainRecord(inner) ||
    inner['model'] !== model ||
    !Array.isArray(inner['input']) ||
    inner['input'].length === 0 ||
    inner['input'].some(
      (item) =>
        !isPlainRecord(item) ||
        (typeof item['type'] !== 'string' && typeof item['role'] !== 'string'),
    )
  ) {
    throw badXaiRequest(
      `transientProviderState must be { xai: { model, input } } with the full xAI wire input, bound to the requested model "${model}".`,
    )
  }
  return value as unknown as XaiReplayState
}

function mapXaiSearchTools(
  tools: unknown,
  model: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    throw badXaiRequest(
      `providerOptions.xai.tools must be an array for model "${model}".`,
    )
  }
  return tools.map((tool, index) => {
    if (!isPlainRecord(tool) || typeof tool['type'] !== 'string') {
      throw badXaiRequest(
        `providerOptions.xai.tools[${index}] must be an object with a type for model "${model}".`,
      )
    }
    if (tool['type'] === 'web_search') {
      const wire: Record<string, unknown> = { type: 'web_search' }
      if (tool['allowedDomains'] !== undefined)
        wire['allowed_domains'] = tool['allowedDomains']
      if (tool['excludedDomains'] !== undefined) {
        wire['excluded_domains'] = tool['excludedDomains']
      }
      if (tool['enableImageUnderstanding'] !== undefined) {
        wire['enable_image_understanding'] = tool['enableImageUnderstanding']
      }
      if (tool['enableImageSearch'] !== undefined) {
        wire['enable_image_search'] = tool['enableImageSearch']
      }
      return wire
    }
    if (tool['type'] === 'x_search') {
      const wire: Record<string, unknown> = { type: 'x_search' }
      if (tool['allowedXHandles'] !== undefined) {
        wire['allowed_x_handles'] = tool['allowedXHandles']
      }
      if (tool['excludedXHandles'] !== undefined) {
        wire['excluded_x_handles'] = tool['excludedXHandles']
      }
      if (tool['fromDate'] !== undefined) wire['from_date'] = tool['fromDate']
      if (tool['toDate'] !== undefined) wire['to_date'] = tool['toDate']
      if (tool['enableImageUnderstanding'] !== undefined) {
        wire['enable_image_understanding'] = tool['enableImageUnderstanding']
      }
      if (tool['enableVideoUnderstanding'] !== undefined) {
        wire['enable_video_understanding'] = tool['enableVideoUnderstanding']
      }
      return wire
    }
    throw badXaiRequest(
      `providerOptions.xai.tools[${index}].type "${String(tool['type'])}" is not supported for model "${model}".`,
    )
  })
}

// ---------------------------------------------------------------------------
// FinishReason mapping (xAI status/incomplete_details → our FinishReason)
// ---------------------------------------------------------------------------

function mapFinishReason(response: XaiResponseShape): FinishReason {
  if (response.status === 'completed') {
    return 'stop'
  }
  if (
    response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'max_output_tokens'
  ) {
    return 'length'
  }
  // Any other status/incomplete_details combination without fixture
  // evidence (or a status we don't recognize) maps to 'other' — the core
  // FinishReason union is closed to these four values.
  return 'other'
}

// ---------------------------------------------------------------------------
// Usage mapping — #1 correctness rule
// ---------------------------------------------------------------------------

/**
 * Usage fields already mapped into canonical {@link Usage} counters — never
 * duplicated into `details` under their raw xAI names.
 */
const CANONICALLY_MAPPED_USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
])

/**
 * Map xAI's `usage` object to our {@link Usage} type.
 *
 * **GROSS convention (ADR-004):**
 * - `usage.input_tokens` is already GROSS (includes cached) → `inputTokens`.
 * - `usage.output_tokens` is already GROSS (includes reasoning) → `outputTokens`.
 * Unlike Gemini, xAI does not require us to sum sub-fields into the gross
 * total — the top-level fields are already gross.
 *
 * **xAI extras** (captured under raw names; not token-priced): every additional
 * NUMERIC top-level usage field (`num_sources_used`,
 * `num_server_side_tools_used` — e.g. after implicit `attachment_search` when
 * files are attached — `cost_in_usd_ticks`, and anything xAI adds later) is
 * surfaced into `details` under its raw name for host visibility. Non-numeric
 * extras (e.g. `context_details`) belong to `AdapterResult.providerMetadata`
 * (see the adapter) and the full raw payload always lands in `Usage.raw`
 * verbatim. Tool invocation fees are billed in `Cost.details.tools` from the
 * live-pinned counters (`web_search_calls`, `x_posts_fetched`, `x_users_fetched`).
 */
function mapUsage(usage: XaiUsageShape): Usage {
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens
  const thinkingTokens = usage.output_tokens_details?.reasoning_tokens
  const totalTokens = usage.total_tokens

  // Canonical details keys: input, output, cached, thinking.
  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedInputTokens !== undefined ? { cached: cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinking: thinkingTokens } : {}),
  }

  // Numeric xAI extras — surfaced under their raw names.
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' && !CANONICALLY_MAPPED_USAGE_KEYS.has(key)) {
      details[key] = value
    }
  }

  // The 2026-08-24 capture located per-call counters in the nested
  // `server_side_tool_usage_details` object. xAI's 2026-09-22 X Search docs
  // added the per-item `x_posts_fetched` and `x_users_fetched` names there.
  // Flatten numeric members under their raw names for provider pricing.
  const toolUsage = usage['server_side_tool_usage_details']
  if (isPlainRecord(toolUsage)) {
    for (const [key, value] of Object.entries(toolUsage)) {
      if (typeof value === 'number') {
        details[key] = value
      }
    }
  }

  const raw: JsonValue = usage as unknown as { [k: string]: JsonValue }

  const result: Usage = {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }

  return result
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Structured-body auth-failure signature, taken verbatim from the recorded
 * live error taxonomy (`__fixtures__/09-error-taxonomy.json`,
 * `invalid_api_key` case): HTTP 400 with body
 * `{ code: 'invalid-argument', error: 'Incorrect API key provided. …' }`.
 *
 * The body `code` (`'invalid-argument'`) is NOT discriminating — xAI uses it
 * for genuinely bad requests too (e.g. `Model not found: grok-99`) — and the
 * `openai` SDK's `APIError` drops it (it hoists only the body's `error`
 * field onto `.error`). The exact message PREFIX xAI emits for bad keys is
 * therefore the signature.
 */
const XAI_AUTH_ERROR_MESSAGE_PREFIX = 'Incorrect API key provided'

/**
 * Extract the STRUCTURED error-body text from a raw thrown value.
 *
 * Consulted shapes (both are parsed-body fields, never free-form
 * `Error.message` text):
 * - `rawErr.error` as a string — the `openai` SDK's `APIError` hoists the
 *   response body's `error` field onto `.error`, which for xAI's
 *   `{ code, error }` bodies is the message string itself.
 * - `rawErr.error` as an object — the full parsed body (test fakes and
 *   hand-rolled throws of the fixture shape `{ status, error: <body> }`);
 *   its `error` (xAI) or `message` (OpenAI-style) string field is read.
 *
 * Free-form `Error.message` is deliberately ignored so arbitrary request
 * content echoed into a message (e.g. a schema-validation error quoting user
 * text that mentions "api key") can never influence classification.
 */
function extractXaiErrorBodyText(rawErr: unknown): string | undefined {
  if (rawErr === null || typeof rawErr !== 'object') {
    return undefined
  }
  const body = (rawErr as Record<string, unknown>)['error']
  if (typeof body === 'string') {
    return body
  }
  if (isPlainRecord(body)) {
    if (typeof body['error'] === 'string') {
      return body['error']
    }
    if (typeof body['message'] === 'string') {
      return body['message']
    }
  }
  return undefined
}

/** True iff the structured body matches xAI's recorded bad-API-key signature. */
function isXaiAuthFailureBody(rawErr: unknown): boolean {
  const text = extractXaiErrorBodyText(rawErr)
  return text !== undefined && text.startsWith(XAI_AUTH_ERROR_MESSAGE_PREFIX)
}

/**
 * Structured-body safety-check signature, taken from the live 2026-08-14
 * capture (`__fixtures__/15-safety-check-403.json`): HTTP 403 with
 * `err.error` as the plain string
 * `"Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER"`.
 *
 * Match the PREFIX only — `SAFETY_CHECK_TYPE_*` suffixes vary. Free-form
 * `Error.message` is never scanned (same anti-echo rule as the auth overlay).
 */
const XAI_SAFETY_CHECK_MESSAGE_PREFIX = 'Content violates usage guidelines'

/** True iff the structured body matches xAI's recorded safety-check signature. */
function isXaiSafetyCheckBody(rawErr: unknown): boolean {
  const text = extractXaiErrorBodyText(rawErr)
  return text !== undefined && text.startsWith(XAI_SAFETY_CHECK_MESSAGE_PREFIX)
}

/**
 * Credits-exhausted / spending-limit signature. DOC-DERIVED, NOT A CAPTURE:
 * the account could not be driven to its limit (probe P7 was not runnable), and
 * xAI's own error reference (docs.x.ai/docs/key-information/debugging, read
 * 2026-10-03) documents 403 and 429 without any body. The body text comes from
 * public bug reports of the live API (continuedev/continue#10373, HTTP 429;
 * LCV-Ideas-Software/cross-review#270, HTTP 403): `Your team <team-id> has
 * either used all available credits or reached its monthly spending limit. To
 * continue making API requests, please purchase more credits or raise your
 * spending limit.` One report also names the code
 * `personal-team-blocked:spending-limit`, which this adapter does not rely on.
 *
 * Only the structured body text is matched (same anti-echo rule as the other
 * overlays), by the stable middle of the sentence, on a 429 or a 403. Replace
 * this with a pinned capture when one exists.
 */
const XAI_CREDITS_EXHAUSTED_BODY =
  /^Your team \S+ has either used all available credits or reached its monthly spending limit/

/** True iff the structured body matches the doc-derived credits-exhausted signature. */
function isXaiCreditsExhaustedBody(rawErr: unknown): boolean {
  const text = extractXaiErrorBodyText(rawErr)
  return text !== undefined && XAI_CREDITS_EXHAUSTED_BODY.test(text)
}

/**
 * True iff `rawErr` is the `openai` SDK's own connection error. The SDK's
 * `APIConnectionError` carries a caller-chosen message in some paths, so it is
 * also matched by class. Matched by constructor name rather than `instanceof`
 * so this file does not need a runtime import of `openai` (per `client.ts`,
 * that package is imported ONLY in `buildXaiClient`, keeping unit tests
 * independent of the real SDK). Every other transport failure (an errno or
 * undici code on the cause chain, `fetch failed`, `Connection error.`) is
 * recognised by core's `classifyError` through `isTransportError`.
 */
function isOpenAiSdkConnectionError(rawErr: unknown): boolean {
  return (
    rawErr instanceof Error &&
    (rawErr.constructor.name === 'APIConnectionError' ||
      rawErr.constructor.name === 'APIConnectionTimeoutError')
  )
}

/** undici error codes for Node's own header and body timers. */
const UNDICI_HEADERS_TIMEOUT_CODE = 'UND_ERR_HEADERS_TIMEOUT'
const UNDICI_BODY_TIMEOUT_CODE = 'UND_ERR_BODY_TIMEOUT'

/**
 * What the adapter knows about the SDK deadline of the call that failed: the
 * `timeout` it handed the SDK and how long the call ran. Without it an
 * `APIConnectionTimeoutError` is never taken for the SDK's own deadline.
 */
export interface XaiSdkDeadline {
  /** The per-request `timeout` the adapter passed to the SDK, in ms. */
  timeoutMs: number
  /** Wall-clock ms between the SDK call starting and the error. */
  elapsedMs: number
}

/** Timers may fire a hair early relative to a monotonic clock. */
const SDK_DEADLINE_SLACK_MS = 5

/**
 * True only for the SDK's own deadline. The `openai` SDK wraps EVERY fetch
 * failure whose text mentions "timed out" (an OS `ETIMEDOUT`, a TLS handshake
 * timeout, a host fetch's own abort) as an `APIConnectionTimeoutError`, so the
 * class alone proves nothing. The SDK's own timer produces that class with no
 * cause (body phase) or with the `AbortError` of its own controller (headers
 * phase), and it cannot fire before the `timeout` the adapter set; both are
 * required. Anything else falls through to the ordinary classification.
 */
function isSdkDeadline(rawErr: unknown, deadline: XaiSdkDeadline | undefined): boolean {
  if (deadline === undefined) return false
  if (
    !(rawErr instanceof Error) ||
    rawErr.constructor.name !== 'APIConnectionTimeoutError'
  ) {
    return false
  }
  const causes = causeChain(rawErr).slice(1)
  if (!causes.every((e) => (e as { name?: unknown }).name === 'AbortError')) return false
  return deadline.elapsedMs >= deadline.timeoutMs - SDK_DEADLINE_SLACK_MS
}

/**
 * Which transport deadline killed the request, or `undefined` when none did.
 *
 * - `'headers'` / `'body'`: Node's undici header or body timer fired (the 300 s
 *   default). Matched by undici error `code` (or class name) anywhere in the
 *   cause chain; the `openai` SDK wraps the undici error as the cause of its
 *   own `APIConnectionTimeoutError`, or lets it escape raw while the body is
 *   read.
 * - `'sdk'`: the SDK's own deadline fired (see {@link isSdkDeadline}).
 *
 * A retry reaches the same limit and repeats the spend, so all three are
 * non-retryable. A connect timeout, an OS `ETIMEDOUT` and a TLS handshake
 * timeout are not matched: nothing reached xAI, so a retry is safe.
 */
function xaiTransportTimeoutKind(
  rawErr: unknown,
  deadline: XaiSdkDeadline | undefined,
): 'headers' | 'body' | 'sdk' | undefined {
  const chain = causeChain(rawErr)
  const has = (code: string, name: string): boolean =>
    chain.some((e) => {
      const o = e as { code?: unknown; name?: unknown }
      return o.code === code || o.name === name
    })
  if (has(UNDICI_HEADERS_TIMEOUT_CODE, 'HeadersTimeoutError')) return 'headers'
  if (has(UNDICI_BODY_TIMEOUT_CODE, 'BodyTimeoutError')) return 'body'
  if (isSdkDeadline(rawErr, deadline)) return 'sdk'
  return undefined
}

/**
 * Classify a raw error thrown from the xAI Responses API call into a typed
 * {@link LlmError}.
 *
 * HTTP status is a hint, not a kind. Overlays inspect the STRUCTURED parsed
 * body only — never free-form `Error.message` — so echoed user content cannot
 * change classification.
 *
 * 1. Already an {@link LlmError} → returned unchanged (including an untagged
 *    one).
 * 2. HTTP 400 whose structured body starts with
 *    `"Incorrect API key provided"` (fixture 09; prefix only — the SDK may
 *    drop `code`) → `invalid_auth`.
 * 3. HTTP 403 whose structured body starts with
 *    `"Content violates usage guidelines"` (fixture 15; `SAFETY_CHECK_TYPE_*`
 *    suffixes vary) → `content_filter`. A bare 403 without that body stays
 *    the core default, `invalid_auth`.
 * 3b. HTTP 429 or 403 whose structured body is the credits-exhausted /
 *    spending-limit sentence (doc-derived, see `XAI_CREDITS_EXHAUSTED_BODY`) →
 *    `rate_limited`, `retryable: false`, `reason: 'credits_exhausted'`.
 * 4. A transport deadline (undici header or body timer, or the SDK's own
 *    deadline, which needs the `deadline` argument to be recognised; see
 *    {@link xaiTransportTimeoutKind}) → `timeout`,
 *    `retryable: false`, `reason: 'transport_timeout'`.
 * 5. A transport failure (core's `classifyError` already makes it a retryable
 *    `server` error; an `openai` SDK connection error that core left `unknown`
 *    is made one here). A connection that never reached xAI is not the
 *    caller's fault.
 * 6. Else rebuild the core classification tagged `provider: 'xai'`.
 */
export function classifyXaiError(rawErr: unknown, deadline?: XaiSdkDeadline): LlmError {
  if (rawErr instanceof LlmError) {
    return rawErr
  }

  const base = classifyError(rawErr)

  const transportTimeout = xaiTransportTimeoutKind(rawErr, deadline)
  if (transportTimeout !== undefined) {
    const which =
      transportTimeout === 'sdk' ? 'SDK deadline' : `transport ${transportTimeout} timer`
    return new LlmError(`xAI request hit the ${which}: ${base.message}`, {
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  if (base.httpStatus === 400 && isXaiAuthFailureBody(rawErr)) {
    return new LlmError(base.message, {
      kind: 'invalid_auth',
      retryable: false,
      httpStatus: base.httpStatus,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  if (base.httpStatus === 403 && isXaiSafetyCheckBody(rawErr)) {
    const bodyText = extractXaiErrorBodyText(rawErr)
    return new LlmError(bodyText ?? base.message, {
      kind: 'content_filter',
      retryable: false,
      httpStatus: base.httpStatus,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  if (
    (base.httpStatus === 429 || base.httpStatus === 403) &&
    isXaiCreditsExhaustedBody(rawErr)
  ) {
    // Out of credits or at the spending limit: neither a retry nor a key
    // rotation helps, the team has to add credit or raise the limit. xAI sends
    // it as a 429 in some reports and a 403 in others.
    // The team id in the sentence is an account identifier: it would land in
    // logs and ledger rows, so the message omits it (it stays on `cause`).
    return new LlmError(
      (extractXaiErrorBodyText(rawErr) ?? base.message).replace(
        /^Your team \S+ /,
        'Your team ',
      ),
      {
        kind: 'rate_limited',
        retryable: false,
        reason: 'credits_exhausted',
        httpStatus: base.httpStatus,
        provider: 'xai',
        cause: base.cause ?? rawErr,
      },
    )
  }

  if (base.kind === 'unknown' && isOpenAiSdkConnectionError(rawErr)) {
    return new LlmError(base.message, {
      kind: 'server',
      retryable: true,
      provider: 'xai',
      cause: base.cause ?? rawErr,
    })
  }

  return new LlmError(base.message, {
    kind: base.kind,
    retryable: base.retryable,
    ...(base.httpStatus !== undefined ? { httpStatus: base.httpStatus } : {}),
    ...(base.retryAfterMs !== undefined ? { retryAfterMs: base.retryAfterMs } : {}),
    provider: 'xai',
    cause: base.cause ?? rawErr,
  })
}

/**
 * How a failed response's `error.code` is classified. A retry is allowed only
 * for a code that names a transient condition (`server_error`,
 * `rate_limit_exceeded`): a deterministic failure is refused again and billed
 * again, and an unrecognised code is not assumed to be transient.
 */
function classifyFailedResponseCode(
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

/** The error for a response with `status` `failed` or `cancelled` (see step 6b). */
function failedResponseError(response: XaiResponseShape): LlmError {
  const reported = isPlainRecord(response.error) ? response.error : undefined
  const code = typeof reported?.['code'] === 'string' ? reported['code'] : undefined
  const detail =
    typeof reported?.['message'] === 'string' ? `: ${reported['message']}` : ''
  const { kind, retryable } =
    response.status === 'cancelled'
      ? ({ kind: 'unknown', retryable: false } as const)
      : classifyFailedResponseCode(code)
  return new LlmError(
    response.status === 'cancelled'
      ? `xAI response reported status "cancelled"${detail}`
      : `xAI response failed${code !== undefined ? ` (error.code "${code}")` : ''}${detail}`,
    {
      kind,
      retryable,
      provider: 'xai',
      // Usage is attached only when the failed response billed tokens.
      ...(isPlainRecord(response.usage) &&
      typeof response.usage.input_tokens === 'number' &&
      typeof response.usage.output_tokens === 'number'
        ? { usage: mapUsage(response.usage) }
        : {}),
      ...(typeof response.service_tier === 'string' && response.service_tier.length > 0
        ? { servedServiceTier: response.service_tier }
        : {}),
      cause: response.error ?? { status: response.status },
    },
  )
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface XaiAdapterOptions {
  /**
   * Inject a pre-built client (real or fake).
   * When omitted, `buildXaiClient` is called with `ctx.auth` at call time,
   * inside the classified try/catch so any construction failure is wrapped
   * as a typed `LlmError`.
   */
  client?: XaiClientLike
  /**
   * HTTP transport (`fetch` and `fetchOptions`) for the SDK client the adapter
   * builds. Required in practice for any call that can run longer than 300 s:
   * the SDK `timeout` alone does not lift Node's header and body timers, so
   * pass an undici `fetch` with an `Agent({ headersTimeout, bodyTimeout })`
   * dispatcher. See the package README. Also used for `countTokens`
   * (`POST /v1/tokenize-text`). Validated and copied when the adapter is
   * created. Cannot be combined with `client` (an injected client owns its own
   * transport).
   */
  transport?: XaiTransport
  /**
   * @internal Testing-only.
   *
   * Override the default `buildXaiClient` factory. Allows unit tests to
   * simulate construction failures without importing the real `openai` SDK.
   * Never set this in production code. Mirrors `GeminiAdapterOptions._clientFactory`.
   */
  _clientFactory?: (
    auth: AuthMaterial,
    transport?: XaiTransport,
  ) => XaiClientLike | Promise<XaiClientLike>
  /**
   * @internal Testing-only.
   *
   * Override `fetch` for `POST /v1/tokenize-text` (not on the openai SDK).
   */
  _fetch?: typeof fetch
}

// ---------------------------------------------------------------------------
// xaiAdapter factory
// ---------------------------------------------------------------------------

/**
 * Validates a host transport and returns a private copy of it.
 *
 * @throws LlmError `bad_request` for a transport that is not an object, whose
 *   `fetch` is not a function, whose `fetchOptions` is not a plain object, or
 *   whose `fetchOptions` carries a key the request owns.
 */
function snapshotXaiTransport(
  transport: XaiTransport | undefined,
): XaiTransport | undefined {
  if (transport === undefined) return undefined
  const reject = (message: string): LlmError =>
    new LlmError(`xaiAdapter: ${message}`, {
      kind: 'bad_request',
      retryable: false,
      provider: 'xai',
    })
  const candidate = transport as unknown
  if (candidate === null || typeof candidate !== 'object') {
    throw reject('transport must be an object { fetch, fetchOptions? }.')
  }
  if (typeof transport.fetch !== 'function') {
    throw reject('transport.fetch must be a function.')
  }
  const fetchOptions = transport.fetchOptions as unknown
  if (fetchOptions === undefined) return { fetch: transport.fetch }
  if (
    fetchOptions === null ||
    typeof fetchOptions !== 'object' ||
    Array.isArray(fetchOptions)
  ) {
    throw reject('transport.fetchOptions must be an object.')
  }
  for (const key of XAI_RESERVED_FETCH_OPTION_KEYS) {
    if (key in fetchOptions) {
      throw reject(`transport.fetchOptions.${key} is not supported; the request owns it.`)
    }
  }
  return {
    fetch: transport.fetch,
    fetchOptions: { ...(fetchOptions as NonNullable<XaiTransport['fetchOptions']>) },
  }
}

/**
 * Create an xAI Grok provider adapter (Responses API).
 *
 * @param opts.client - Optional pre-built client (e.g. for testing).
 * @param opts.transport - Optional `fetch` + `fetchOptions` for the built client.
 */
export function xaiAdapter(opts?: XaiAdapterOptions): ProviderAdapter {
  if (opts?.client !== undefined && opts.transport !== undefined) {
    throw new LlmError(
      'xaiAdapter: `transport` has no effect on an injected `client`; configure the transport on the client itself.',
      { kind: 'bad_request', retryable: false, provider: 'xai' },
    )
  }
  // Validated and copied once: the host mutating its own transport object
  // afterwards cannot reach the SDK or `countTokens`.
  const transport = snapshotXaiTransport(opts?.transport)
  return {
    id: 'xai',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      if (req.provider !== 'xai') {
        throw new LlmError(
          `xaiAdapter received a request for provider "${req.provider}", expected "xai".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const warnings: Warning[] = []
      const model = req.model
      if (req.modelDescriptor !== undefined) {
        assertModelMatchesDescriptor(req, req.modelDescriptor, 'xai')
      }
      // A direct adapter call without a descriptor is checked against the
      // built-in one, so media types are never silently unchecked.
      const mediaDescriptor = req.modelDescriptor ?? xaiRegistry.resolve('xai', model)
      if (mediaDescriptor !== undefined) {
        assertInputMimeTypesAdmitted(req.messages, mediaDescriptor, 'xai')
      }
      if (
        xaiRegistry.resolve('xai', model)?.capabilities?.continuation === 'state' &&
        req.modelDescriptor?.capabilities?.continuation !== 'state'
      ) {
        throw badXaiRequest(
          `A matching xAI model descriptor with continuation "state" is required for "${model}".`,
        )
      }
      const genConfig = req.config
      const xaiProviderConfig = mapXaiProviderOptions(
        genConfig.providerOptions?.['xai'],
        model,
      )

      // ------------------------------------------------------------------
      // 1. Map messages → input
      // ------------------------------------------------------------------
      const replayRequired = req.modelDescriptor?.capabilities?.continuation === 'state'
      const replayState = parseXaiReplayState(req.transientProviderState, model)
      if (replayState !== undefined && !replayRequired) {
        throw badXaiRequest(
          `transientProviderState requires a model descriptor with continuation "state" for "${model}".`,
        )
      }
      if (replayState !== undefined && req.messages.length === 0) {
        throw badXaiRequest(
          `Stateless conversation replay for model "${model}" requires new messages to append.`,
        )
      }
      const input: XaiRequestInputItem[] = [...(replayState?.xai.input ?? [])]
      const replayCallIds = new Set(
        replayState?.xai.input
          .filter((item) => isPlainRecord(item) && item['type'] === 'function_call')
          .map((item) => (isPlainRecord(item) ? item['call_id'] : undefined))
          .filter((id): id is string => typeof id === 'string') ?? [],
      )
      const replayedResultIds = new Set(
        replayState?.xai.input
          .filter(
            (item) => isPlainRecord(item) && item['type'] === 'function_call_output',
          )
          .map((item) => (isPlainRecord(item) ? item['call_id'] : undefined))
          .filter((id): id is string => typeof id === 'string') ?? [],
      )
      for (const msg of req.messages) {
        if (replayState !== undefined && msg.role === 'assistant') {
          throw badXaiRequest(
            `New messages for model "${model}" cannot contain assistant history when transientProviderState is supplied.`,
          )
        }
        if (
          replayRequired &&
          replayState === undefined &&
          msg.parts.some(
            (part) => part.kind === 'tool-call' || part.kind === 'tool-result',
          )
        ) {
          throw badXaiRequest(
            `Function-call history for model "${model}" requires transientProviderState from the prior result.`,
          )
        }
        const contentParts: XaiInputContentPart[] = []
        for (const part of msg.parts) {
          if (part.kind === 'tool-call') {
            if (contentParts.length > 0) {
              input.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: contentParts.splice(0),
              })
            }
            input.push({
              type: 'function_call',
              call_id: part.toolCallId,
              name: part.toolName,
              arguments: JSON.stringify(part.args),
            })
            continue
          }
          if (part.kind === 'tool-result') {
            if (
              replayState !== undefined &&
              (!replayCallIds.has(part.toolCallId) ||
                replayedResultIds.has(part.toolCallId))
            ) {
              throw badXaiRequest(
                `Tool result "${part.toolCallId}" must match an unanswered function call in transientProviderState.`,
              )
            }
            replayedResultIds.add(part.toolCallId)
            if (contentParts.length > 0) {
              input.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: contentParts.splice(0),
              })
            }
            input.push({
              type: 'function_call_output',
              call_id: part.toolCallId,
              output: JSON.stringify(part.result),
            })
            continue
          }
          contentParts.push(mapPart(part))
        }
        if (contentParts.length > 0) {
          input.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: contentParts,
          })
        }
      }
      // ------------------------------------------------------------------
      // 2. Build request params
      // ------------------------------------------------------------------
      const params: XaiResponseCreateParams = {
        model,
        input,
        store: false,
      }

      if (req.system !== undefined) {
        params.instructions = req.system
      }

      // Sampling — forwarded verbatim, no clamping (schema enforces bounds
      // upstream of the adapter).
      if (genConfig.temperature !== undefined) {
        params.temperature = genConfig.temperature
      }
      if (genConfig.topP !== undefined) {
        params.top_p = genConfig.topP
      }

      // max_output_tokens — forwarded as given. xAI documents no output limit,
      // so the schema applies no cap (`limits.maxOutputTokens` is null) and the
      // provider decides; truncation surfaces as finishReason:'length', not an
      // error (see mapFinishReason).
      if (genConfig.maxOutputTokens !== undefined) {
        params.max_output_tokens = genConfig.maxOutputTokens
      }

      // serviceTier — descriptor-driven. All three registered models admit
      // priority (4.5 live-verified 2026-09-25; 4.6 on 2026-08-12).
      // xAI silently remaps flex to default, so the strict schemas reject it.
      const admittedTiers = req.modelDescriptor?.capabilities?.serviceTiers
      if (genConfig.serviceTier !== undefined) {
        if (
          admittedTiers === undefined ||
          !admittedTiers.includes(genConfig.serviceTier)
        ) {
          throw badXaiRequest(
            `serviceTier is not supported for xai model "${model}" (got "${genConfig.serviceTier}").`,
          )
        }
        if (genConfig.serviceTier !== 'priority') {
          throw badXaiRequest(
            `serviceTier "${genConfig.serviceTier}" is not supported for xai model "${model}" (only "priority" is admitted).`,
          )
        }
        params.service_tier = 'priority'
      }

      // ------------------------------------------------------------------
      // 3. Reasoning → { effort }
      //
      // Admitted efforts are descriptor-owned. grok-4.5: `'low' | 'medium' | 'high'`
      // (live-verified 2026-08-24). grok-4.6: `'low' | 'medium' | 'high' | 'xhigh'`
      // (live-verified 2026-08-12). `'none'` is rejected by both. budgetTokens
      // is not supported (level-style reasoning). includeThoughts is a no-op
      // for xAI — reasoning summaries come back unconditionally whenever
      // reasoning ran, so reasoningText is always surfaced below regardless
      // of this flag; we do not throw on it since it is a legitimate
      // ReasoningIntent field this provider simply doesn't need.
      // ------------------------------------------------------------------
      const reasoning = genConfig.reasoning
      if (reasoning !== undefined) {
        if (reasoning.budgetTokens !== undefined) {
          throw badXaiRequest(
            `reasoning.budgetTokens is not supported for model "${model}" (xAI uses effort-level reasoning, not token budgets); use reasoning.effort instead.`,
          )
        }

        if (reasoning.effort !== undefined) {
          const effort = reasoning.effort
          if (effort === 'none' || effort === 'max') {
            throw badXaiRequest(
              `reasoning.effort "${effort}" is not supported for xai model "${model}".`,
            )
          }
          const admitted = req.modelDescriptor?.capabilities?.admittedReasoningEfforts
          // Fail-closed without a descriptor, matching the serviceTier branch:
          // a host-supplied descriptor that omits admittedReasoningEfforts
          // must not silently re-admit medium/xhigh onto grok-4.5.
          if (admitted === undefined || !admitted.includes(effort)) {
            throw badXaiRequest(
              `reasoning.effort "${effort}" is not supported for xai model "${model}".`,
            )
          }
          params.reasoning = { effort }
        }
      }

      // ------------------------------------------------------------------
      // 4. Structured output → text.format (NOT response_format)
      // ------------------------------------------------------------------
      const structuredOutputRequested = req.outputJsonSchema !== undefined
      if (structuredOutputRequested) {
        const schema = req.outputJsonSchema
        assertJsonSchemaProfile(
          schema as JsonValue,
          'output.jsonSchema',
          XAI_JSON_SCHEMA_PROFILE,
        )
        const name =
          isPlainRecord(schema) &&
          typeof schema['title'] === 'string' &&
          schema['title'].length > 0
            ? schema['title']
            : 'structured_output'
        params.text = {
          format: { type: 'json_schema', name, schema, strict: true },
        }
      }

      // ------------------------------------------------------------------
      // 5. providerOptions.xai → prompt_cache_key
      // ------------------------------------------------------------------
      if (xaiProviderConfig.promptCacheKey !== undefined) {
        params.prompt_cache_key = xaiProviderConfig.promptCacheKey
      }

      const hasFileRef = input.some(
        (item) =>
          isPlainRecord(item) &&
          Array.isArray(item['content']) &&
          item['content'].some(
            (part) => isPlainRecord(part) && part['type'] === 'input_file',
          ),
      )
      const searchTools = xaiProviderConfig.tools
      if (searchTools !== undefined) {
        if (req.modelDescriptor?.capabilities?.grounding !== true) {
          throw badXaiRequest(
            `providerOptions.xai.tools requires capabilities.grounding on the model descriptor for "${model}".`,
          )
        }
        if (
          structuredOutputRequested &&
          req.modelDescriptor.capabilities.structuredOutputWithTools !== true
        ) {
          throw badXaiRequest(
            `Structured output with providerOptions.xai.tools is not supported for model "${model}".`,
          )
        }
        params.tools = searchTools
        // Responses carries one request-wide `tool_choice`, and `required`
        // means "at least one tool" — a function call would satisfy it. The
        // option is therefore server-tool-only: it cannot promise a search
        // once function tools are declared.
        if (xaiProviderConfig.toolChoice !== undefined) {
          if (req.toolChoice !== undefined) {
            throw badXaiRequest(
              `providerOptions.xai.toolChoice and toolChoice cannot both be set for model "${model}"; xAI accepts one tool_choice per request.`,
            )
          }
          if (req.tools !== undefined && req.tools.length > 0) {
            throw badXaiRequest(
              `providerOptions.xai.toolChoice applies to the server-side search tools only and cannot be combined with function tools for model "${model}".`,
            )
          }
          // A file attachment implicitly enables xAI's `attachment_search`,
          // which is a tool too: it could satisfy `required` without a web
          // or X search. Not live-probed (the ZDR key blocks attachments).
          if (hasFileRef) {
            throw badXaiRequest(
              `providerOptions.xai.toolChoice cannot be combined with file attachments for model "${model}"; xAI's implicit attachment_search would count as the tool call.`,
            )
          }
          params.tool_choice = xaiProviderConfig.toolChoice
        }
        // Forwarded verbatim per the Responses contract. It caps agentic
        // turns, not individual searches, and the 2026-10-02 probes
        // (fixture 33) showed the server not enforcing it yet.
        if (xaiProviderConfig.maxTurns !== undefined) {
          params.max_turns = xaiProviderConfig.maxTurns
        }
      }

      if (req.tools !== undefined && req.tools.length > 0) {
        if (req.modelDescriptor?.capabilities?.functionCalling !== true) {
          throw badXaiRequest(
            `tools is not supported for xai model "${model}" (capabilities.functionCalling is not true).`,
          )
        }
        req.tools.forEach((tool, index) => {
          assertJsonSchemaProfile(
            tool.inputJsonSchema,
            `tools[${index}].inputJsonSchema`,
            XAI_JSON_SCHEMA_PROFILE,
          )
        })
        const functionTools = req.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputJsonSchema,
        }))
        params.tools = [...(params.tools ?? []), ...functionTools]
        if (req.toolChoice !== undefined) {
          params.tool_choice =
            typeof req.toolChoice === 'string'
              ? req.toolChoice
              : { type: 'function', name: req.toolChoice.name }
        }
      }
      if (xaiProviderConfig.parallelToolCalls !== undefined) {
        // It only governs how a response orders its tool calls, so with no tool
        // (function or server) on the request it has nothing to act on.
        if (params.tools === undefined || params.tools.length === 0) {
          throw badXaiRequest(
            `providerOptions.xai.parallelToolCalls requires at least one tool (function tools or providerOptions.xai.tools) for model "${model}".`,
          )
        }
        params.parallel_tool_calls = xaiProviderConfig.parallelToolCalls
      }

      // ------------------------------------------------------------------
      // 6. Client construction + SDK call — inside the classifier so ANY
      //    failure (including bad auth construction) is rethrown as a typed
      //    LlmError(provider:'xai').
      // ------------------------------------------------------------------
      let response: XaiResponseShape
      let responseMeta: XaiResponseMeta | undefined
      let sdkCallStart: { startedAt: number; timeoutMs: number } | undefined
      try {
        const buildClient = opts?._clientFactory ?? buildXaiClient
        const client: XaiClientLike =
          opts?.client !== undefined
            ? opts.client
            : await buildClient(ctx.auth, transport)
        ctx.logger.debug(
          { model, configKeys: Object.keys(params) },
          'llm.adapter.dispatch',
        )
        // SDK deadline: timeoutMs + buffer so the engine's own deadline (armed
        // at exactly timeoutMs) fires first; one hour when no timeoutMs is set.
        // It does not lift Node's 300 s header timer (that needs `transport`).
        const sdkTimeoutMs =
          genConfig.timeoutMs !== undefined
            ? genConfig.timeoutMs + XAI_TIMEOUT_BUFFER_MS
            : XAI_DEFAULT_TIMEOUT_MS
        const requestOptions: XaiRequestOptions = {
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          timeout: sdkTimeoutMs,
          onResponse: (meta) => {
            responseMeta = meta
          },
        }
        sdkCallStart = { startedAt: performance.now(), timeoutMs: sdkTimeoutMs }
        response = await client.responses.create(params, requestOptions)
      } catch (rawErr) {
        throw classifyXaiError(
          rawErr,
          sdkCallStart !== undefined
            ? {
                timeoutMs: sdkCallStart.timeoutMs,
                elapsedMs: performance.now() - sdkCallStart.startedAt,
              }
            : undefined,
        )
      }

      // ------------------------------------------------------------------
      // 6b. A 200 that reports failure. DOC-DERIVED, NOT A CAPTURE: xAI's
      //     reference lists `status` completed|in_progress|incomplete and names
      //     an `error` object without its shape. `failed` and `cancelled`, and
      //     the `error.code` values, come from OpenAI's Responses object (the
      //     API xAI is compatible with), where `error` is set only when the
      //     response failed. Only those two statuses are failures: an `error`
      //     object beside a completed response is not a documented shape, and
      //     a billed, usable answer is never thrown away for it.
      // ------------------------------------------------------------------
      if (response.status === 'failed' || response.status === 'cancelled') {
        throw failedResponseError(response)
      }

      // ------------------------------------------------------------------
      // 7. Map response
      // ------------------------------------------------------------------
      let text = ''
      let reasoningText: string | undefined
      const messageItems: XaiMessageOutputItem[] = []
      const toolCalls: NonNullable<AdapterResult['toolCalls']> = []
      // Output order of the representable items (message and function_call);
      // the assistant message is built from it once the last message item is known.
      const outputOrder: Array<
        XaiMessageOutputItem | NonNullable<AdapterResult['toolCalls']>[number]
      > = []

      for (const item of response.output) {
        if (isXaiMessageItem(item)) {
          messageItems.push(item)
          outputOrder.push(item)
        } else if (isXaiReasoningItem(item)) {
          const joined = item.summary.map((s) => s.text).join('')
          if (joined.length > 0) {
            reasoningText = (reasoningText ?? '') + joined
          }
        } else if (item.type === 'function_call') {
          const callId = typeof item['call_id'] === 'string' ? item['call_id'] : ''
          const name = typeof item['name'] === 'string' ? item['name'] : ''
          let args: JsonValue = {}
          if (typeof item['arguments'] === 'string') {
            try {
              args = JSON.parse(item['arguments']) as JsonValue
            } catch {
              args = item['arguments']
            }
          }
          if (callId.length > 0 && name.length > 0) {
            const call = { toolCallId: callId, toolName: name, args }
            toolCalls.push(call)
            outputOrder.push(call)
          }
        }
      }

      // xAI's Responses API convention: when multiple `type: 'message'`
      // output items are present, the LAST one is the response — earlier
      // ones are superseded (observed live in strict json_schema mode,
      // grok-4.5, reasoning effort high: two complete-JSON message items in
      // one response). Concatenating across items corrupts the payload
      // (e.g. two JSON documents back-to-back); joining `output_text` parts
      // WITHIN a single message item is still correct (segmentation, not
      // duplication).
      if (messageItems.length > 0) {
        const lastMessage = messageItems[messageItems.length - 1] as XaiMessageOutputItem
        text = lastMessage.content.map((part) => part.text).join('')

        if (messageItems.length > 1) {
          warnings.push({
            type: 'other',
            message: `xai: response contained ${messageItems.length} message output items; using the last one and discarding ${
              messageItems.length - 1
            } earlier message item(s).`,
          })
        }
      }

      // Ordered assistant message: provider order, the last message item as the
      // single text part (earlier ones are superseded, as for `text`), reasoning
      // and server-tool items omitted (they live in the replay state).
      const lastMessageItem = messageItems[messageItems.length - 1]
      const messageParts: Part[] = []
      for (const entry of outputOrder) {
        if ('toolCallId' in entry) {
          messageParts.push({ kind: 'tool-call', ...entry })
        } else if (entry === lastMessageItem && text.length > 0) {
          messageParts.push({ kind: 'text', text })
        }
      }

      // Parse structured output (JSON text → rawStructured).
      let rawStructured: unknown
      if (structuredOutputRequested && text.length > 0) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          // Core reports unparsed via absence of rawStructured; callers own
          // validation/retry policy (ADR-009).
        }
      }

      const usage = mapUsage(response.usage)
      const finishReason = mapFinishReason(response)

      const expectedToolCounters = expectedServerToolCounters(
        xaiProviderConfig.tools,
        hasFileRef,
      )
      // A response where no server tool ran reports
      // `num_server_side_tools_used: 0` and omits the per-tool counters
      // (live 2026-10-02, fixture 32: `tool_choice: 'none'`; the same shape
      // comes back when the model skips the search under `auto`). That is an
      // explicit zero, not a missing counter, so the call prices exactly
      // with no tool cost. A zero that arrives WITH a counters object is
      // contradictory and keeps the missing-counter checks.
      const noServerToolRan =
        response.usage['num_server_side_tools_used'] === 0 &&
        response.usage['server_side_tool_usage_details'] === undefined
      // Normalised search facts (ADR-035), the same names on every provider:
      // `web_search_requested` is 1 when the request enabled web search, and
      // `web_search_calls` is the observed count. The count comes from the
      // provider's counters; an explicit "no server tool ran" is a known zero.
      if (
        xaiProviderConfig.tools?.some((tool) => tool['type'] === 'web_search') === true
      ) {
        usage.details['web_search_requested'] = 1
        if (noServerToolRan) usage.details[WEB_SEARCH_COUNTER] = 0
      }
      // The call is already billed when the counters arrive, so an exceeded
      // budget is reported, never thrown: the result is still returned.
      if (xaiProviderConfig.searchBudget !== undefined) {
        const over = exceededSearchBudget(xaiProviderConfig.searchBudget, usage.details)
        if (over.length > 0) {
          usage.details['search_budget_exceeded'] = 1
          warnings.push({
            type: 'other',
            message: `xai: search budget exceeded (${over.join('; ')}); the call is already billed and its result is returned.`,
          })
        }
      }
      // A non-zero counter for a server tool that xAI bills per use and the
      // pricing snapshot has no rate for (code interpreter, file or document
      // search, image generation), or one the snapshot does not know, is not
      // priced here: the call is priced 'estimated' and understates. Token-only
      // tools (MCP) are fully priced by their tokens and do not warn.
      const unpricedCounters = unpricedXaiToolCounters(usage)
      if (unpricedCounters.length > 0) {
        warnings.push({
          type: 'other',
          message: `xai: server tool counter(s) [${unpricedCounters
            .map((key) => `${key}=${String(usage.details[key])}`)
            .join(
              ', ',
            )}] are non-zero but have no rate in the pricing snapshot (xAI bills the tool per use, or the counter is unknown); the call's cost is estimated and understates.`,
        })
      }
      if ((expectedToolCounters.length > 0 || hasFileRef) && !noServerToolRan) {
        usage.details['server_tools_requested'] = 1
        if (
          xaiProviderConfig.tools?.some((tool) => tool['type'] === 'x_search') === true
        ) {
          usage.details['x_search_requested'] = 1
        }
        const missing = expectedToolCounters.filter((key) => !(key in usage.details))
        if (missing.length > 0) {
          usage.details['server_tools_missing'] = 1
          warnings.push({
            type: 'other',
            message: `xai: server tools were requested but usage is missing counters [${missing.join(
              ', ',
            )}]; the call is unpriced.`,
          })
        }
        if (hasFileRef) {
          // Attachment_search counter is not live-pinned (ZDR blocks file
          // attach). Never claim exact $0 for a file-ref call.
          usage.details['attachment_search_unpinned'] = 1
          warnings.push({
            type: 'other',
            message:
              'xai: file-ref enables attachment_search but that counter is not live-pinned; tool cost is estimated.',
          })
        }
      }

      const citations = collectXaiCitations(response, messageItems, (message) =>
        warnings.push({ type: 'other', message }),
      )

      // Response-level metadata → providerMetadata: usage.context_details
      // (non-numeric usage extra) and response.metadata (e.g.
      // system_fingerprint). Numeric usage extras live in usage.details; the
      // full raw usage payload is already in usage.raw.
      const providerMeta: { [k: string]: JsonValue } = {}
      const contextDetails = response.usage['context_details']
      if (isPlainRecord(contextDetails)) {
        providerMeta['context_details'] = contextDetails as unknown as JsonValue
      }
      if (isPlainRecord(response.metadata)) {
        providerMeta['metadata'] = response.metadata as unknown as JsonValue
      }
      // The HTTP response's request id and remaining-quota headers, when the
      // client exposes them (the real client does).
      if (responseMeta !== undefined) {
        const xaiMeta: { [k: string]: JsonValue } = {}
        if (responseMeta.requestId !== undefined)
          xaiMeta['requestId'] = responseMeta.requestId
        if (responseMeta.rateLimitRemaining !== undefined) {
          xaiMeta['rateLimitRemaining'] = { ...responseMeta.rateLimitRemaining }
        }
        if (Object.keys(xaiMeta).length > 0) providerMeta['xai'] = xaiMeta
      }
      let transientProviderState: JsonValue | undefined
      if (replayRequired) {
        // Preserve every provider output item in wire order. This includes
        // messages and encrypted server-tool items that normalized Message
        // cannot represent. The next request appends only new user/tool-result
        // messages; callers do not repeat normalized history with state.
        const state: XaiReplayState = {
          xai: { model, input: [...params.input, ...response.output] },
        }
        transientProviderState = state as unknown as JsonValue
      }

      // Surface the echoed tier verbatim. xAI can remap (flex → default);
      // discarding non-priority values would let the engine fall back to the
      // requested tier and bill 2× on a default-served call.
      const servedServiceTier =
        typeof response.service_tier === 'string' && response.service_tier.length > 0
          ? response.service_tier
          : undefined

      const result: AdapterResult = {
        model: response.model,
        message: { role: 'assistant', parts: messageParts },
        usage,
        warnings,
        finishReason,
        responseId: response.id,
        ...(text.length > 0 ? { text } : {}),
        ...(reasoningText !== undefined ? { reasoningText } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(servedServiceTier !== undefined ? { servedServiceTier } : {}),
        ...(Object.keys(providerMeta).length > 0
          ? { providerMetadata: providerMeta }
          : {}),
        ...(transientProviderState !== undefined ? { transientProviderState } : {}),
        ...(citations.length > 0 ? { citations } : {}),
        ...(toolCalls.length > 0 ? { toolCalls, finishReason: 'tool_calls' } : {}),
      }

      return result
    },

    async countTokens(req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> {
      if (req.provider !== 'xai') {
        throw new LlmError(
          `xaiAdapter received a request for provider "${req.provider}", expected "xai".`,
          { kind: 'bad_request', retryable: false },
        )
      }
      if (req.tools !== undefined && req.tools.length > 0) {
        throw badXaiRequest(
          'xAI countTokens rejects tools; tokenize-text cannot represent tool declarations.',
        )
      }

      const text = concatenateTokenizeText(req)
      const apiKey = requireApiKey(ctx.auth)
      const fetchImpl = opts?._fetch ?? transport?.fetch ?? fetch

      try {
        const res = await fetchImpl('https://api.x.ai/v1/tokenize-text', {
          // The host transport's init (a dispatcher, say) first; the request
          // owns the keys below, which `snapshotXaiTransport` keeps out of it.
          ...(opts?._fetch === undefined ? transport?.fetchOptions : undefined),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: req.model, text }),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })

        if (!res.ok) {
          let parsed: unknown
          try {
            parsed = await res.json()
          } catch {
            parsed = await res.text().catch(() => '')
          }
          throw Object.assign(new Error(`xAI tokenize-text HTTP ${res.status}`), {
            status: res.status,
            error: parsed,
          })
        }

        const raw: unknown = await res.json()
        if (!isPlainRecord(raw) || !Array.isArray(raw['token_ids'])) {
          throw new LlmError(
            'xAI tokenize-text response is malformed: missing required field: token_ids',
            { kind: 'server', retryable: true, provider: 'xai' },
          )
        }
        const n = raw['token_ids'].length
        return {
          totalTokens: n,
          accuracy: 'lower-bound',
          details: { textTokens: n },
          raw: raw as JsonValue,
        }
      } catch (rawErr) {
        if (rawErr instanceof Error && rawErr.name === 'AbortError') {
          throw new LlmError('xAI tokenize-text aborted', {
            kind: 'aborted',
            retryable: false,
            provider: 'xai',
            cause: rawErr,
          })
        }
        throw classifyXaiError(rawErr)
      }
    },
  }
}

/** Counter names from `usage.server_side_tool_usage_details`. */
const WEB_SEARCH_COUNTER = 'web_search_calls'
function expectedServerToolCounters(
  tools: Array<Record<string, unknown>> | undefined,
  _hasFileRef: boolean,
): string[] {
  const keys: string[] = []
  if (tools !== undefined) {
    for (const tool of tools) {
      if (tool['type'] === 'web_search') keys.push(WEB_SEARCH_COUNTER)
      if (tool['type'] === 'x_search') keys.push(...X_SEARCH_ITEM_COUNTERS)
    }
  }
  return keys
}

/**
 * Citations from the response: the top-level source list first, then the last
 * message's `url_citation` annotations, deduplicated by URL.
 *
 * An annotation with a non-empty `start_index`/`end_index` range marks an
 * inline citation. xAI writes the marker into the answer as `[[N]](url)` and
 * the range covers exactly that marker, indexed from the start of the
 * `output_text` part that carries it (fixtures 17, 26, 30 and 32; every
 * captured message has one part). The adapter treats the indices as UTF-16
 * code units and adds the part's offset in the joined answer text, and it
 * checks the result: the slice must be `[[label]](<the annotation's url>)`.
 * When it is, the source is `cited: true` with that `textRange`, and a title
 * equal to `label` (xAI numbers its markers: `title: "1"`) is dropped, so a
 * real title that happens to be numeric survives. When it is not (a base
 * other than UTF-16 or part-relative, an answer with emoji or several parts
 * that xAI indexes differently), the range is dropped, the source stays
 * `cited: true` because xAI did report an inline range, and `onDropped` says
 * why: never a range that points at the wrong span.
 *
 * `cited` is never `false`. A zero-width (`0`/`0`) or missing range means xAI
 * reported no inline marker range for the source; it does not mean the answer
 * does not cite it (fixture 19: the answer text carries inline
 * `render_inline_citation` markup while its three annotations are `0`/`0`;
 * structured answers, fixtures 18 and 32, have only `0`/`0` annotations), so
 * `cited` stays absent. A source from the top-level list alone says nothing
 * about citing either.
 */
/** `label` when `marker` is exactly `[[label]](url)`, else `undefined`. */
function inlineMarkerLabel(marker: string, url: string): string | undefined {
  const tail = `]](${url})`
  return marker.startsWith('[[') &&
    marker.endsWith(tail) &&
    marker.length >= 2 + tail.length
    ? marker.slice(2, marker.length - tail.length)
    : undefined
}

function collectXaiCitations(
  response: XaiResponseShape,
  messageItems: XaiMessageOutputItem[],
  onDropped: (message: string) => void,
): Citation[] {
  const byUrl = new Map<string, Citation>()

  const upsert = (
    url: unknown,
    title: unknown,
    markerLabel?: string,
  ): Citation | undefined => {
    if (typeof url !== 'string' || url.length === 0) return undefined
    let citation = byUrl.get(url)
    if (citation === undefined) {
      citation = { url }
      try {
        const parsed = new URL(url)
        if (parsed.hostname.length > 0) {
          citation.sourceName = parsed.hostname.startsWith('www.')
            ? parsed.hostname.slice(4)
            : parsed.hostname
        }
      } catch {
        /* keep url-only */
      }
      byUrl.set(url, citation)
    }
    if (
      citation.title === undefined &&
      typeof title === 'string' &&
      title.length > 0 &&
      title !== url &&
      title !== markerLabel
    ) {
      citation.title = title
    }
    return citation
  }

  if (Array.isArray(response.citations)) {
    for (const item of response.citations) {
      if (typeof item === 'string') {
        upsert(item, undefined)
      } else if (isPlainRecord(item)) {
        upsert(item['url'] ?? item['uri'], item['title'])
      }
    }
  }

  const lastMessage = messageItems.at(-1)
  if (lastMessage !== undefined) {
    const joined = lastMessage.content.map((part) => part.text).join('')
    let partOffset = 0
    for (const part of lastMessage.content) {
      const annotations = part.annotations
      if (Array.isArray(annotations)) {
        for (const ann of annotations) {
          if (!isPlainRecord(ann)) continue
          if (ann['type'] !== undefined && ann['type'] !== 'url_citation') continue
          const start = ann['start_index']
          const end = ann['end_index']
          const hasRange =
            typeof start === 'number' &&
            typeof end === 'number' &&
            Number.isInteger(start) &&
            Number.isInteger(end) &&
            start >= 0 &&
            end > start
          const url = ann['url']
          const label =
            hasRange && typeof url === 'string'
              ? inlineMarkerLabel(joined.slice(partOffset + start, partOffset + end), url)
              : undefined
          const citation = upsert(url, ann['title'], label)
          if (citation === undefined || !hasRange) continue
          citation.cited = true
          if (label === undefined) {
            onDropped(
              `xai: dropped a textRange for a citation of ${citation.url}: the answer at start_index ${start}, end_index ${end} is not the inline [[N]](url) marker. The source stays cited without a range.`,
            )
          } else {
            citation.textRange ??= { start: partOffset + start, end: partOffset + end }
          }
        }
      }
      partOffset += part.text.length
    }
  }

  return [...byUrl.values()]
}

function concatenateTokenizeText(req: TokenCountRequest): string {
  const chunks: string[] = []
  if (req.system !== undefined && req.system.length > 0) {
    chunks.push(req.system)
  }
  for (const message of req.messages) {
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          chunks.push(part.text)
          break
        case 'inline-media':
        case 'file-uri':
        case 'file-ref':
        case 'tool-call':
        case 'tool-result':
          throw badXaiRequest(
            `xAI countTokens rejects ${part.kind} parts; tokenize-text is text-only.`,
          )
        default:
          return assertNever(part)
      }
    }
  }
  return chunks.join('\n')
}
