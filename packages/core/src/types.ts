/**
 * Core types for @gullabs/core.
 *
 * These types form the stable public surface of the library.  All other
 * packages depend on them; changing a type here is a breaking change.
 *
 * @module
 */

import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// Primitive JSON value (used throughout for open / forward-compat lanes)
// ---------------------------------------------------------------------------

/**
 * A type-safe representation of any value that is valid JSON.
 * Used for raw provider metadata, open token-detail maps, and persisted
 * blobs that must survive without schema migration.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Host-supplied key-value anchors attached to every call.
 * Examples: `tenantId`, `runId`, `callSiteId`, `traceId`.
 * Persisted verbatim in the `metadata` JSONB column.
 */
export type CallMetadata = Record<string, JsonValue>

/**
 * A single text part in a message.
 * The `kind` discriminant allows narrowing within the {@link Part} union.
 */
export type TextPart = { kind: 'text'; text: string }

/**
 * An inline binary media part, base64-encoded.
 *
 * `data` must be a **raw base64 string** with **no** `data:<mime>;base64,`
 * prefix — the prefix is stripped/rejected by most provider SDKs.
 *
 * `mediaResolution` is a normalised cross-provider hint for image/video
 * detail level (`'low'` reduces tokens; `'high'` maximises fidelity).
 * Adapters map this to the closest provider-specific setting and throw
 * `LlmError('bad_request')` when the model cannot honour it.
 */
export type InlineMediaPart = {
  kind: 'inline-media'
  /** IANA media type, e.g. `"image/png"`, `"video/mp4"`. */
  mimeType: string
  /**
   * Raw base64-encoded bytes — **no** `data:…;base64,` prefix.
   * Most provider SDKs expect bare base64.
   */
  data: string
  /**
   * Cross-provider media detail hint.
   * `'low'` → fewer tokens / lower cost.
   * `'medium'` → balanced (provider default when omitted).
   * `'high'` → highest fidelity / most tokens.
   * Adapters throw `LlmError('bad_request')` when the model cannot honour the hint.
   */
  mediaResolution?: 'low' | 'medium' | 'high'
}

/**
 * A provider-hosted file reference part.
 *
 * Used when a file has already been uploaded to the provider's file-storage
 * service (e.g. Gemini File API).  The provider dereferences `uri` server-side,
 * so no binary payload is sent with the request.
 *
 * `mediaResolution` behaves identically to {@link InlineMediaPart.mediaResolution}.
 */
export type FileUriPart = {
  kind: 'file-uri'
  /** Provider-assigned URI, e.g. `"https://generativelanguage.googleapis.com/v1beta/files/…"`. */
  uri: string
  /** IANA media type of the referenced file, e.g. `"image/jpeg"`, `"video/mp4"`. */
  mimeType: string
  /**
   * Cross-provider media detail hint — see {@link InlineMediaPart.mediaResolution}.
   * Adapters throw `LlmError('bad_request')` when the model cannot honour the hint.
   */
  mediaResolution?: 'low' | 'medium' | 'high'
}

/**
 * A provider-hosted file **id** reference (not a URI).
 *
 * Used when a file has been uploaded to a provider that addresses files by
 * opaque id rather than by URI (e.g. xAI Files `file_…`).  The provider
 * dereferences `fileId` server-side; no binary payload is sent with the
 * request.  Distinct from {@link FileUriPart}: ids are not URIs and must not
 * be stuffed into the `file-uri` lane.
 *
 * Adapters that only understand URI-based file hosting reject this part with
 * `LlmError('bad_request')` (reject-don't-map).
 */
export type FileRefPart = {
  kind: 'file-ref'
  /** Provider-assigned file id, e.g. xAI `"file_a128090d-…"`. */
  fileId: string
  /** Optional IANA type hint for hosts/telemetry; adapters may ignore. */
  mimeType?: string
}

/**
 * An assistant-emitted tool call. Only valid on `assistant` messages.
 */
export type ToolCallPart = {
  kind: 'tool-call'
  toolCallId: string
  toolName: string
  args: JsonValue
}

/**
 * A user-supplied tool result. Only valid on `user` messages.
 */
export type ToolResultPart = {
  kind: 'tool-result'
  toolCallId: string
  toolName: string
  result: JsonValue
  isError?: boolean
}

/**
 * Discriminated union of all supported message part kinds.
 * Switch on `part.kind` for exhaustive narrowing.
 */
export type Part =
  TextPart | InlineMediaPart | FileUriPart | FileRefPart | ToolCallPart | ToolResultPart

// ---------------------------------------------------------------------------
// Part type guards
// ---------------------------------------------------------------------------

/**
 * Narrows `part` to {@link TextPart}.
 * @example
 * ```ts
 * if (isTextPart(p)) console.log(p.text)
 * ```
 */
export function isTextPart(part: Part): part is TextPart {
  return part.kind === 'text'
}

/**
 * Narrows `part` to {@link InlineMediaPart}.
 * @example
 * ```ts
 * if (isInlineMediaPart(p)) sendBase64(p.mimeType, p.data)
 * ```
 */
export function isInlineMediaPart(part: Part): part is InlineMediaPart {
  return part.kind === 'inline-media'
}

/**
 * Narrows `part` to {@link FileUriPart}.
 * @example
 * ```ts
 * if (isFileUriPart(p)) useProviderUri(p.uri)
 * ```
 */
export function isFileUriPart(part: Part): part is FileUriPart {
  return part.kind === 'file-uri'
}

/**
 * Narrows `part` to {@link FileRefPart}.
 * @example
 * ```ts
 * if (isFileRefPart(p)) attachById(p.fileId)
 * ```
 */
export function isFileRefPart(part: Part): part is FileRefPart {
  return part.kind === 'file-ref'
}

/** Narrows `part` to {@link ToolCallPart}. */
export function isToolCallPart(part: Part): part is ToolCallPart {
  return part.kind === 'tool-call'
}

/** Narrows `part` to {@link ToolResultPart}. */
export function isToolResultPart(part: Part): part is ToolResultPart {
  return part.kind === 'tool-result'
}

/**
 * A single message in the conversation history.
 * `parts` is a heterogeneous array of {@link Part} values — text, inline
 * media, and provider-hosted file references can be freely mixed.
 */
export type Message = { role: 'user' | 'assistant'; parts: Part[] }

/**
 * Intent for the model's internal reasoning / chain-of-thought capability.
 * Adapters map this to provider-specific knobs (e.g. Gemini `thinkingConfig`)
 * Adapters throw `LlmError('bad_request')` when the mapping cannot be applied.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ReasoningIntent {
  /**
   * Abstract effort level. Admitted values are per-model (`admittedReasoningEfforts`).
   * - Gemini 2.5 → maps to `thinkingBudget` tokens (`xhigh` is rejected).
   * - Gemini 3.x → maps to `thinkingLevel` (`xhigh` is rejected).
   * - xAI grok-4.6/4.7 → Responses `reasoning.effort`, including native `xhigh`.
   * - Codex and Claude CLI → native `max` where admitted by the model schema.
   */
  effort?: ReasoningEffort
  /** Explicit token budget for budget-API models; schemas reject it with `effort`. */
  budgetTokens?: number
  /**
   * When `true`, the adapter requests the provider to return the thought-summary
   * text, which is then surfaced as `reasoningText` on the result and record.
   */
  includeThoughts?: boolean
}

/**
 * Open, augmentable map of per-provider option shapes.
 *
 * Empty by default — provider packages extend it via declaration merging:
 * ```ts
 * declare module '@gullabs/core' {
 *   interface ProviderOptionsMap {
 *     google?: GoogleProviderOptions
 *   }
 * }
 * ```
 * See `packages/google/src/types.ts` for the reference implementation. A key
 * only appears here once its owning provider package is imported.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentable via declaration merging; intentionally empty by default
export interface ProviderOptionsMap {}

export type ProviderOptions = ProviderOptionsMap

/** Common generation knobs plus schema-admitted provider extension lanes. */
export interface GenConfig {
  /** Sampling temperature (0–2 typical). */
  temperature?: number
  /** Nucleus sampling probability mass. */
  topP?: number
  /** Top-k sampling. */
  topK?: number
  /**
   * Hard cap on generated tokens. It includes reasoning/thinking tokens on
   * providers that reason, so a low cap on a reasoning model can be used up
   * before any answer is produced; the call then ends with
   * `finishReason: 'length'` and a warning on the result.
   */
  maxOutputTokens?: number
  /** Stop sequences — generation halts when any string is produced. */
  stopSequences?: string[]
  /** Reasoning / thinking intent; exact fields are selected by the model schema. */
  reasoning?: ReasoningIntent
  /**
   * Explicit service tier. Opaque provider-defined string — admitted values
   * are constrained by each model's strict config schema (e.g. Gemini schemas
   * admit `'flex' | 'standard'`; models without tiers never admit this key at
   * all since their schemas are strict and reject unknown keys). Omitted tier
   * stays omitted and uses provider-default request behavior.
   */
  serviceTier?: string
  /**
   * Overall time ceiling for the logical call, in milliseconds: a finite
   * number greater than 0 and at most 2147483647 (`bad_request` otherwise; a
   * longer timer would fire after 1 ms).
   *
   * The clock starts when the call starts and is measured on the client's
   * `clock`, so middleware time (a quota deferral, a store round-trip) counts
   * against it. It is a **true ceiling across retry attempts** when the retry
   * middleware is installed: the sum of all attempt windows plus back-off sleep
   * never exceeds this value. The engine enforces it by:
   * - Giving each attempt only the time that is left (`attemptTimeoutMs`).
   * - Refusing to start an attempt once the budget is exhausted.
   * - Ending a call whose middleware (not an attempt) is taking the time, or
   *   that is still running after the last attempt failed at the deadline,
   *   with a `timeout` that carries the last attempt's error as `cause`; when
   *   that error is itself a `timeout` or carries a provider `retryAfterMs`, it
   *   is the error surfaced.
   * - Returning a result an attempt already produced (and billed) rather than
   *   turning it into a timeout when work after `next()` runs past it.
   *
   * The retry middleware shares the same budget (`EngineCtx.deadlineAt`) and
   * rethrows the failed attempt's own error, without sleeping, when the
   * back-off would leave the next attempt less than 250 ms.
   *
   * With no retry middleware it is simply the single-attempt timeout.
   */
  timeoutMs?: number
  /** Schema-admitted provider extension lanes. Not a raw SDK passthrough. */
  providerOptions?: ProviderOptions
}

/**
 * A request to an LLM.
 *
 */
/**
 * A caller-defined function the model may invoke.
 * `description` is required (xAI documents it as required; reject-don't-map).
 */
export interface ToolDefinition {
  name: string
  description: string
  inputJsonSchema: JsonValue
}

/** How the model should choose among {@link LlmRequest.tools}. */
export type ToolChoice = 'auto' | 'required' | 'none' | { name: string }

export interface LlmRequest {
  /**
   * Explicit provider identifier — the engine routes by this field directly
   * (`adapterMap.get(provider)`), never by deriving it from `model`.
   * Must match a configured adapter's `id`; otherwise the engine throws
   * `LlmError('bad_request')`.
   */
  provider: string
  /**
   * Provider-native model string, forwarded verbatim to the adapter/SDK.
   * Identity for registry/pricing/routing purposes is the pair
   * (`provider`, `model`) — the bare string alone is not unique across
   * providers.
   */
  model: string
  /** Optional system instruction prepended to the conversation. */
  system?: string
  /**
   * Conversation history.
   * Parts may be text, inline media (base64), or provider-hosted file references.
   */
  messages: Message[]
  /**
   * Optional function-calling tools. Tools-in / tool-call+tool-result-parts
   * out — no agent loop. Invalid without unique non-empty names and
   * non-empty descriptions.
   */
  tools?: ToolDefinition[]
  /**
   * Tool selection policy. Only valid when {@link tools} is present.
   */
  toolChoice?: ToolChoice
  /**
   * Optional structured output hint.
   *
   * The adapter forwards this JSON Schema to providers that support native
   * structured output, JSON-parses the response, and reports `outputParsed`.
   * The library never validates the parsed value; callers own validation,
   * retry, and acceptance policy.
   */
  output?: { jsonSchema: JsonValue }
  /** Generation configuration; merged over library defaults and call-site defaults. */
  config?: GenConfig
  /**
   * Opaque provider continuation state from a previous result, passed back as
   * `LlmResult.continuation` says. Provider-scoped and bound to this request's
   * `model` string; only models that declare `capabilities.providerState` admit
   * it. Forwarded to the adapter but never persisted.
   */
  transientProviderState?: JsonValue
  /** Host-supplied metadata anchors persisted verbatim. */
  metadata?: CallMetadata
  /** Optional call-site identifier for direct `generate()` observability grouping. */
  callSiteId?: string
  /**
   * Optional caller-owned correlation id persisted on every attempt row of the
   * call. Give every host-level retry of one logical operation the same
   * `externalId`; each attempt is still its own billed row with its own
   * `attemptId`, and the library never deduplicates provider calls.
   */
  externalId?: string
  /**
   * Optional opt-in input contract for the `generate()` path (D3).
   *
   * When present, `value` is validated against `schema` (the
   * `~standard.validate` seam) inside `runPipeline`, immediately after
   * `callId` allocation and before the middleware chain is entered — before
   * `@gullabs/quota` (never consumes budget on a violation) and before the
   * retry middleware (validated exactly once per logical call, never per
   * attempt). On violation, throws `LlmError('bad_request')`, not
   * retryable, with structured `issues` and `callId` attached; because this
   * is post-`callId`, the refusal writes a synthetic zero-usage ledger row
   * (D5).
   *
   * Consumed by the engine only: `inputContract` is never copied onto the
   * `ResolvedRequest` an adapter sees. `runStructured` builds its
   * `LlmRequest` internally and never sets this field — callsite consumers
   * use `CallSite.inputSchema` instead (D2); the two are independent, one
   * contract per path.
   */
  inputContract?: {
    /** StandardSchema validator for `value`. */
    schema: StandardSchemaV1
    /** The value to validate against `schema`. */
    value: unknown
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Why the model stopped generating. */
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other' | 'tool_calls'

/**
 * A normalized citation produced by a provider adapter.
 *
 * Adapters own shaping (ADR-023). `undefined` on the result means the
 * provider produced none / the feature was unused — empty arrays are omitted.
 * Raw provider payloads stay in `providerMetadata`.
 */
export interface Citation {
  url: string
  title?: string
  sourceName?: string
  /**
   * Whether the answer text itself cites this source: `true` when the provider
   * ties the source to a span of the text, `false` when the provider reports
   * citing information and this source is not part of it (it was returned but
   * no span points at it; Gemini with `groundingSupports`). Absent when the
   * provider does not say: xAI never sets `false`, because a `0`/`0` annotation
   * means "no inline marker range reported", not "not cited".
   */
  cited?: boolean
  /**
   * The span of `LlmResult.text` the provider ties this source to, as UTF-16
   * code unit offsets (`start` inclusive, `end` exclusive, so
   * `text.slice(start, end)` is the span). When a source backs several spans
   * this is the first one; the provider's full mapping stays in
   * `providerMetadata`. What the span covers is the provider's choice: Gemini
   * gives the supported sentence, xAI gives its inline citation marker. Absent
   * when the provider gives no usable span.
   */
  textRange?: { start: number; end: number }
}

/**
 * A warning emitted for advisory information that does not prevent the call
 * from succeeding. Warnings are never silently dropped — they appear on the
 * result and record.
 */
export type Warning = {
  type: 'other'
  /** Free-form message for any other advisory. */
  message: string
}

/**
 * Per-call token usage.
 *
 * **GROSS convention:**
 * - `cachedInputTokens` is a *subset* of `inputTokens` (not additive).
 * - `thinkingTokens` is a *subset* of `outputTokens` (not additive).
 * Cost math must account for this to avoid double-counting.
 */
export interface Usage {
  /** Total input tokens billed (includes cached tokens). */
  inputTokens: number
  /** Total output tokens billed (includes thinking tokens). */
  outputTokens: number
  /** Tokens served from the KV cache (subset of `inputTokens`). */
  cachedInputTokens?: number
  /** Internal reasoning tokens (subset of `outputTokens`). */
  thinkingTokens?: number
  /** `inputTokens + outputTokens` if returned by the provider. */
  totalTokens?: number
  /**
   * Open token-type map for forward compatibility.
   * New token kinds added by providers land here without requiring a schema
   * migration; each key is eligible for cost calculation.
   */
  details: Record<string, number>
  /**
   * The provider's complete raw usage object, stored verbatim.
   * Allows post-hoc cost recalculation when the pricing table changes.
   */
  raw: JsonValue
}

/**
 * Cost in micro-USD, frozen at write time.
 *
 * When the cost is **priced** (`microUsd` is a `number`), the `details`
 * breakdown **must** satisfy:
 * ```
 * details.input + details.cached + details.output + details.tools === microUsd
 * ```
 * Thinking tokens are billed at the output rate and are folded into
 * `details.output` — there is no separate `thinking` lane. Tool-invocation
 * fees live in `details.tools` (0 when the call had no priced tools).
 *
 * When the cost is **unpriced** (`microUsd: null`), this invariant does not
 * apply: `details` is zero-filled
 * (`{ input: 0, cached: 0, output: 0, tools: 0 }`) rather than meaningful,
 * so it trivially sums to `0`, not to `microUsd`.
 */
export interface Cost {
  /**
   * Total cost in micro-USD (1 USD = 1,000,000 µUSD).
   * `null` when this snapshot cannot safely price the model, tier, or usage;
   * tokens are still captured for later reconciliation or backfill.
   */
  microUsd: number | null
  /**
   * Derived convenience view of `microUsd` in whole USD (= `microUsd / 1_000_000`).
   * Display-only; micro-USD is canonical and is the value persisted.
   * `null` when unpriced.
   */
  usd: number | null
  /** Identifies the pricing snapshot used (e.g. `"gemini-2026-06-27"`). */
  pricingVersion: string
  /**
   * `'exact'` when all priced fields came directly from the provider.
   * `'estimated'` when any field had to be inferred or defaulted.
   */
  confidence: 'exact' | 'estimated'
  /**
   * Per-category cost breakdown in micro-USD.
   * Must sum to `microUsd`.
   */
  details: {
    /** Cost of non-cached input tokens. */
    input: number
    /** Cost of cached input tokens (usually discounted). */
    cached: number
    /** Cost of output tokens (thinking is billed here, not separately). */
    output: number
    /** Tool charges. */
    tools: number
  }
  /**
   * Present only when `microUsd` is `null`. Names the specific reason pricing
   * was refused (e.g. an unrecognized model, or an unrecognized service tier)
   * — never a silent substitution. Consumers (e.g. the engine) surface this
   * verbatim in the "unpriced" warning.
   */
  unpricedReason?: string
  /**
   * The total the provider itself reported billing for this call, in micro-USD,
   * when it reports one (xAI's `cost_in_usd_ticks`). Informational: `microUsd`
   * stays the library's own snapshot price and is never replaced by it. It is
   * present even when `microUsd` is `null`, so a host can use the provider's
   * figure for a call the snapshot cannot price.
   *
   * The engine compares the two totals and adds a warning when they differ by
   * more than the per-lane rounding of the priced lanes: a drift means the
   * pricing snapshot is stale or a lane is missing. A provider reports a total
   * only, so there is no per-lane reconciliation.
   */
  providerReported?: { microUsd: number }
}

/**
 * What a whole logical call cost across every attempt (retries and billed
 * failures included), as far as the library could price it.
 *
 * - `microUsd` sums the micro-USD of the attempts that were priced. If any
 *   priced attempt's `Cost.confidence` was `'estimated'` the sum is an
 *   estimate too (read `Cost.confidence` per attempt on `Telemetry.onAttempt`).
 * - `attempts` is the number of provider attempts that began.
 * - `unpricedAttempts` counts attempts that were dispatched but have no priced
 *   usage: a timeout, abort or connection failure that reported no usage, usage
 *   the pricing source could not price, or an attempt still in flight when the
 *   call ended. The provider may have billed them. Attempts known to cost nothing
 *   (rejected before dispatch, a provider 400/401/429 or other HTTP error answer)
 *   are not counted.
 *
 * `unpricedAttempts > 0` means `microUsd` is a **lower bound**; `0` means every
 * attempt is accounted for. The SQL sum of `cost_micro_usd` over the call's rows
 * equals `microUsd` (NULL rows add nothing, and a failure that reported no usage
 * leaves a row with no cost).
 */
export interface CallCost {
  /** Micro-USD of the priced attempts, summed. */
  microUsd: number
  /** Provider attempts that began. */
  attempts: number
  /** Attempts dispatched with no priced usage; `> 0` makes `microUsd` a lower bound. */
  unpricedAttempts: number
}

/**
 * The value returned by a successful (or partially-successful) LLM call.
 *
 */
export interface LlmResult {
  /**
   * JSON-parsed structured output.
   * Present only when `request.output.jsonSchema` was supplied and JSON parsing
   * succeeded. Always `unknown`; callers validate.
   */
  output?: unknown
  /**
   * Whether JSON parsing succeeded for a structured-output request.
   * Present only when `request.output.jsonSchema` was supplied.
   */
  outputParsed?: boolean
  /**
   * The assistant's output as an ordered message (`role: 'assistant'`): the
   * representable output parts **in provider order** — text parts kept
   * separate, tool calls with their id, name and arguments. Provider parts with
   * no {@link Part} representation (thought parts) are omitted, so part
   * indices are defined over `message.parts` after that omission. Present on
   * every successful result; `text` and `toolCalls` are conveniences derived
   * from the same output.
   *
   * Append it to history exactly as returned when {@link continuation} is
   * `'history'`; never replay it when `'state'` (see {@link continuation}).
   */
  message: Message
  /**
   * How the next turn of a tool loop is sent, repeated from the model
   * descriptor's `capabilities.continuation` so a host does not need a registry
   * lookup:
   *
   * - `'history'` — append {@link message} to the history, send the full
   *   history, and pass {@link transientProviderState} back when present.
   * - `'state'` — {@link transientProviderState} already holds the provider's
   *   output; send **only the new messages** plus the state. {@link message}
   *   is for display and the host's own storage and must not be replayed.
   *
   * The next turn goes to the same `provider` and the same `model` string the
   * host sent (a declared alias stays an alias).
   */
  continuation: 'history' | 'state'
  /** Raw text content from the model. */
  text?: string
  /**
   * Provider-returned thought-summary text.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned a thought summary.
   */
  reasoningText?: string
  /** Token usage for this call (always present). */
  usage: Usage
  /**
   * Cost in micro-USD.
   * Absent when the model is not in the pricing table.
   */
  cost?: Cost
  /**
   * What the whole call cost, across every attempt: see {@link CallCost}.
   * `cost` is the successful attempt alone. Present whenever at least one
   * attempt ran. When `callCost.unpricedAttempts > 0`, `callCost.microUsd` is a
   * lower bound. Per-attempt detail is on `Telemetry.onAttempt` and in the ledger.
   */
  callCost?: CallCost
  /**
   * The model identifier as returned by the provider (may differ from the
   * requested string, for example a dated snapshot behind an alias). Do not
   * route on it: send the next turn with the `model` string you sent.
   */
  model: string
  /** Provider-specific model version string (e.g. `"gemini-2.5-pro-001"`). */
  modelVersion?: string
  /** Why the model stopped generating. */
  finishReason?: FinishReason
  /** Provider-assigned response ID for deduplication and support queries. */
  responseId?: string
  /** Service tier actually served by the provider. */
  servedServiceTier?: string
  /** Wall-clock time from request dispatch to response ready, in milliseconds. */
  latencyMs: number
  /** Time spent waiting in the configured RateLimiter before provider dispatch. */
  queueDelayMs?: number
  /**
   * Warnings emitted during the call.
   * Always an array (possibly empty); never `undefined`.
   */
  warnings: Warning[]
  /**
   * Normalized citations produced by the adapter.
   * Absent when the provider produced none / the feature was unused.
   * Empty arrays are never emitted.
   */
  citations?: Citation[]
  /**
   * Projection of assistant `tool-call` parts for dispatch.
   * May coexist with `text`.
   */
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonValue }>
  /**
   * Raw provider metadata (grounding citations, safety ratings, etc.).
   * Stored as JsonValue to avoid a hard coupling to provider-specific types.
   */
  providerMetadata?: JsonValue
  /**
   * Opaque provider continuation state, scoped to the provider and bound to the
   * requested model. The caller owns secure storage and replay; pass it back
   * with the next turn as {@link continuation} says.
   */
  transientProviderState?: JsonValue
  /**
   * Library-assigned stable identifier for this logical call.
   * Use this to correlate the result with the persisted `LlmCallRecord`
   * (same `callId` on the record) and with provider logs.
   */
  callId: string
  /**
   * Library-assigned identifier for the specific attempt that produced this
   * result.  With retries, this is the SUCCESSFUL attempt's id — distinct
   * from earlier attempts that failed.  Matches the persisted record's
   * `attemptId` when the sink write succeeds (the sink is fail-open).
   */
  attemptId: string
}
