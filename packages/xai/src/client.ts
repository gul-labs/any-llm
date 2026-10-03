/**
 * Structural XaiClientLike interface + buildXaiClient factory.
 *
 * This module defines the structural interface the adapter depends on.
 * The real `openai` SDK is imported ONLY in buildXaiClient so tests can
 * inject a fake without pulling in the real SDK. This is the ONLY file in
 * `packages/xai/src` that imports `openai`.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { AuthMaterial } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Auth narrowing — xAI only accepts ApiKeyAuth
// ---------------------------------------------------------------------------

/**
 * Narrows {@link AuthMaterial} to its `apiKey` string, rejecting the
 * dev-only `CliSessionAuth` variant.
 *
 * xAI is a production API provider and only ever accepts API-key
 * credentials; `{ cliSession: true }` is reserved for the dev-only CLI
 * provider packages (`@gullabs/claude-cli`, `@gullabs/codex-cli`).
 */
export function requireApiKey(auth: AuthMaterial): string {
  if (
    !('apiKey' in auth) ||
    typeof auth.apiKey !== 'string' ||
    auth.apiKey.trim() === ''
  ) {
    throw new LlmError('@gullabs/xai requires auth.apiKey', {
      kind: 'invalid_auth',
      retryable: false,
      provider: 'xai',
    })
  }
  return auth.apiKey
}

// ---------------------------------------------------------------------------
// Request shape — what the (future) adapter sends to responses.create
// ---------------------------------------------------------------------------

/** A text content item within an xAI Responses API input message. */
export interface XaiInputTextPart {
  type: 'input_text'
  text: string
}

/**
 * An image content item within an xAI Responses API input message.
 * `image_url` may be a data URL (`data:image/png;base64,...`) or a public URL.
 */
export interface XaiInputImagePart {
  type: 'input_image'
  image_url: string
}

/**
 * A file attachment content item within an xAI Responses API input message.
 * Prefer `file_id` for private uploads (via {@link XaiFileStore}); `file_url`
 * is for publicly reachable documents. Attaching either implicitly enables
 * xAI's `attachment_search` agentic tool.
 */
export interface XaiInputFilePart {
  type: 'input_file'
  file_id?: string
  file_url?: string
}

/** Union of content-part shapes an input message may carry. */
export type XaiInputContentPart = XaiInputTextPart | XaiInputImagePart | XaiInputFilePart

/** A single role+content input item constructed by the (future) adapter. */
export interface XaiInputItem {
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: XaiInputContentPart[]
}

/** Live-verified store:false replay item. */
export interface XaiFunctionCallInputItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

/** Live-verified store:false replay item. */
export interface XaiFunctionCallOutputInputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

export type XaiRequestInputItem =
  XaiInputItem | XaiFunctionCallInputItem | XaiFunctionCallOutputInputItem | XaiOutputItem

/** Full wire history for stateless continuation. */
export interface XaiReplayState {
  model: string
  input: XaiRequestInputItem[]
}

/**
 * Structured-output text-format request shape.
 * Real xAI field: `text.format`, NOT `response_format`.
 * `name` and `strict` are included per xAI's Structured Outputs docs
 * conventions even though the live fixture's request-echo does not surface
 * them (only the schema is echoed back).
 */
export type XaiTextFormat =
  | { type: 'json_schema'; name: string; schema: unknown; strict: boolean }
  | { type: 'text' }

/**
 * Parameters for `client.responses.create`.
 * Structurally modeled from live-captured xAI Responses API fixtures
 * (see docs/provider-plugins-and-xai-grok-4-5-plan.md §3.1), not from the
 * `openai` npm package's TS types — xAI's actual endpoint shape differs.
 */
export interface XaiResponseCreateParams {
  model: string
  input: XaiRequestInputItem[]
  instructions?: string
  reasoning?: { effort: 'low' | 'medium' | 'high' | 'xhigh' }
  text?: { format: XaiTextFormat }
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  prompt_cache_key?: string
  /**
   * Responses `service_tier`. Only `'priority'` is forwarded (live-verified
   * on grok-4.6, 2026-08-12). Omitted when the caller did not request a tier.
   */
  service_tier?: 'priority'
  /** Always `false` — this library never relies on xAI-side conversation storage. */
  store: false
  /**
   * Server-side and/or function tools. Wire names are snake_case.
   * Shape is pinned from live 2026-08-24 fixtures.
   */
  tools?: Array<Record<string, unknown>>
  /** `'auto' | 'required' | 'none'` or live-verified `{ type: 'function', name }`. */
  tool_choice?: string | { type: 'function'; name: string }
  max_turns?: number
  parallel_tool_calls?: boolean
}

// ---------------------------------------------------------------------------
// Response shape — mirrors the xAI Responses API surface we actually consume
// ---------------------------------------------------------------------------

/** A single summary-text segment of a `type: 'reasoning'` output item. */
export interface XaiReasoningSummaryPart {
  type: 'summary_text'
  text: string
}

/** A `type: 'reasoning'` item in `output`. */
export interface XaiReasoningOutputItem {
  type: 'reasoning'
  id?: string
  summary: XaiReasoningSummaryPart[]
  status?: string
}

/** A single text content segment of a `type: 'message'` output item. */
export interface XaiOutputTextPart {
  type: 'output_text'
  text: string
  logprobs?: unknown[]
  annotations?: unknown[]
}

/** A `type: 'message'` item in `output`. */
export interface XaiMessageOutputItem {
  type: 'message'
  id?: string
  role?: string
  status?: string
  content: XaiOutputTextPart[]
}

/** Server-tool or function-call output items we do not collapse as messages. */
export interface XaiOtherOutputItem {
  type: string
  [key: string]: unknown
}

/** Union of output-item shapes the Responses API may return. */
export type XaiOutputItem =
  XaiReasoningOutputItem | XaiMessageOutputItem | XaiOtherOutputItem

/**
 * Token usage metadata returned alongside an xAI response.
 *
 * Kept loose/open: the known fields are typed, but xAI has been observed to
 * add additional numeric fields (e.g. `num_sources_used`,
 * `cost_in_usd_ticks`, `context_details`) that must not break this type.
 */
export interface XaiUsageShape {
  input_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
  /** Additional provider-specific usage fields, passed through raw. */
  [otherKeys: string]: unknown
}

/**
 * Structural equivalent of the xAI Responses API response body.
 * Only the fields the (future) adapter reads are represented here.
 */
export interface XaiResponseShape {
  id: string
  model: string
  /**
   * Real field: `status`. Observed values: "completed", "incomplete" — kept
   * as a plain `string` since xAI may add further status values over time.
   */
  status: string
  incomplete_details?: { reason?: string } | null
  output: XaiOutputItem[]
  usage: XaiUsageShape
  reasoning?: { effort?: string; summary?: string }
  /**
   * Echoed served tier. Observed values: `"default"`, `"priority"`.
   * Kept as a plain string — xAI may add further values.
   */
  service_tier?: string
  store?: boolean
  prompt_cache_key?: string | null
  /**
   * Response-level metadata (e.g. `system_fingerprint`) — surfaced into
   * `AdapterResult.providerMetadata` by the adapter when present.
   */
  metadata?: { [key: string]: unknown } | null
  /**
   * Top-level citations array. Live 2026-08-24 search-tools probes returned
   * `null`; citations arrived as `output_text.annotations` of type
   * `url_citation` instead.
   */
  citations?: unknown
}

// ---------------------------------------------------------------------------
// XaiClientLike — structural interface (no `openai` dependency)
// ---------------------------------------------------------------------------

/**
 * Structural interface for the `openai` SDK's `client.responses` surface
 * the adapter uses.
 *
 * Satisfied by:
 * - The real `openai` `OpenAI` client (via `buildXaiClient` wrapper), pointed
 *   at xAI's `https://api.x.ai/v1` base URL.
 * - `FakeXaiClient` from `@gullabs/testing`.
 */
export interface XaiClientLike {
  responses: {
    create(
      params: XaiResponseCreateParams,
      options?: XaiRequestOptions,
    ): Promise<XaiResponseShape>
  }
}

/** Per-request options the adapter passes to `responses.create`. */
export interface XaiRequestOptions {
  signal?: AbortSignal
  /**
   * The SDK's own whole-request deadline in milliseconds. It does not move
   * Node's header and body timers; see {@link XaiTransport}.
   */
  timeout?: number
}

/**
 * Host-supplied HTTP transport for every `responses.create` call.
 *
 * Node's `fetch` enforces its own 300 s header and body timers, independent of
 * the SDK `timeout`. A non-streamed call that waits longer than that is killed
 * unless the host passes a `fetch` whose dispatcher raises those timers (for
 * example undici's `fetch` with `new Agent({ headersTimeout, bodyTimeout })`
 * in `fetchOptions.dispatcher`). See ADR-032 and the package README.
 */
export interface XaiTransport {
  fetch: typeof fetch
  /**
   * Extra `fetch` init (for example `{ dispatcher }`). `headers`, `signal`,
   * `body` and `method` belong to the request and are rejected.
   */
  fetchOptions?: Omit<RequestInit, 'headers' | 'signal' | 'body' | 'method'>
}

/** `fetchOptions` keys the SDK owns; a host-supplied value would override the request. */
export const XAI_RESERVED_FETCH_OPTION_KEYS = [
  'headers',
  'signal',
  'body',
  'method',
] as const

/**
 * SDK deadline for a request with no `timeoutMs`: one hour. xAI reasoning and
 * agentic calls can run for many minutes; the SDK default (10 minutes) would
 * cut them off.
 */
export const XAI_DEFAULT_TIMEOUT_MS = 3_600_000

/**
 * Added to `timeoutMs` for the SDK deadline, so the engine's own deadline
 * (armed at exactly `timeoutMs`) always fires first and the caller sees the
 * engine's clean timeout rather than a raw SDK error.
 */
export const XAI_TIMEOUT_BUFFER_MS = 5_000

// ---------------------------------------------------------------------------
// buildXaiClient — imports the real `openai` SDK
// ---------------------------------------------------------------------------

/**
 * Build a real `openai`-SDK-backed client from AuthMaterial, pointed at
 * xAI's Responses API endpoint.
 *
 * Only API-key authentication is supported.
 *
 * @param auth - API key credentials ({ apiKey }).
 * @param transport - Optional host-supplied `fetch` and `fetchOptions` passed to
 *   the SDK client unchanged.
 */
export async function buildXaiClient(
  auth: AuthMaterial,
  transport?: XaiTransport,
): Promise<XaiClientLike> {
  // Resolve and validate auth BEFORE importing the SDK so auth-rejection
  // tests never need to touch the real `openai` module (and thus never hit
  // the network).
  const apiKey = requireApiKey(auth)

  const { default: OpenAI } = await import('openai')

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.x.ai/v1',
    maxRetries: 0,
    ...(transport !== undefined
      ? {
          fetch: transport.fetch,
          ...(transport.fetchOptions !== undefined
            ? { fetchOptions: transport.fetchOptions }
            : {}),
        }
      : {}),
  })

  return {
    responses: {
      async create(
        params: XaiResponseCreateParams,
        options?: XaiRequestOptions,
      ): Promise<XaiResponseShape> {
        // Cast needed: our structural types are subsets of the real SDK types,
        // and the real SDK's types do not exactly match xAI's actual response
        // shape (see module doc comment).
        return (
          client.responses.create as unknown as (
            p: unknown,
            o?: XaiRequestOptions,
          ) => Promise<XaiResponseShape>
        )(params, options)
      },
    },
  }
}
