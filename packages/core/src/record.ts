/**
 * Persisted call record for @gullabs/core.
 *
 * `LlmCallRecord` is the canonical shape written to the `llm_calls` table by
 * `@gullabs/drizzle` (or any custom `UsageSink`).  `buildRecord` assembles it
 * from engine-internal inputs with no I/O.
 *
 * @module
 */

import type {
  JsonValue,
  Usage,
  FinishReason,
  Warning,
  GenConfig,
  Cost,
  Citation,
} from './types.js'
import type { LlmErrorKind, LlmErrorReason, LlmError } from './errors.js'
import { assertNever } from './assert.js'
import { cleanText, redactJsonValue, redactSecrets, setOwn } from './redact.js'

// ---------------------------------------------------------------------------
// Record interface
// ---------------------------------------------------------------------------

/**
 * A complete, immutable snapshot of a single LLM call attempt.
 *
 * Designed for append-only storage: the record is written once after the call
 * completes (success or failure).  Idempotency key: `attemptId`.
 *
 * `recordSchemaVersion` must be checked before deserialization; increment it
 * on any breaking schema change.
 */
export interface LlmCallRecord {
  /**
   * Schema version — always `2` for this release. Version 2 added
   * `costConfidence`, `costDetails` and `costUnpricedReason` (ADR-039).
   */
  recordSchemaVersion: 2

  // --- identity ---
  /** Unique ID for the logical call (shared across retries). */
  callId: string
  /**
   * Unique ID for this specific attempt, always minted by the engine — also
   * for `attemptNumber: 0` refusal rows. It only de-duplicates an at-least-once
   * sink re-delivering the same record; it is never derived from host input.
   * Correlate host retries of one operation through `externalId`.
   */
  attemptId: string
  /**
   * Ordinal of this attempt within the logical call.
   *
   * `0` means the call was refused before any attempt ran (a `bad_request`
   * input-contract violation, a `@gullabs/quota`-style pre-attempt denial,
   * or any other `LlmError` a middleware throws before the engine's
   * innermost handler begins). Real attempts are 1-based: `1` = first
   * attempt, `2` = first retry, and so on.
   *
   * A refusal after an earlier attempt ran (a quota deferral or boundary
   * refusal on attempt 2, say) is a zero-usage row numbered with the refused
   * attempt. An attempt a middleware refused and a later attempt re-ran leaves
   * no row, so a gap in attempt numbers means "refused before dispatch".
   */
  attemptNumber: number
  /** Optional call-site identifier for grouping by prompt template. */
  callSiteId?: string
  /** Optional caller-owned correlation id for host ledgers. */
  externalId?: string
  /**
   * Opaque caller-supplied label identifying which credential (`ApiKeyAuth.keyId`)
   * was used for the dispatch attempt that produced this record (ADR-026).
   * Absent when the resolved auth material had no `keyId` (e.g. `CliSessionAuth`,
   * or an `ApiKeyAuth` that omitted it). Never a secret — safe to display
   * unredacted in per-key analytics.
   */
  authKeyId?: string

  // --- routing ---
  /** Provider identifier (e.g. `"google"`). */
  provider: string
  /** Requested model string (e.g. `"gemini-2.5-pro"`). */
  model: string
  /** Provider-specific model version returned in the response. */
  modelVersion?: string
  /** Provider-assigned response ID for deduplication and support queries. */
  responseId?: string
  /** Service tier used for this call (e.g. `"flex"` | `"standard"`). */
  serviceTier?: string
  /** Service tier actually served by the provider. */
  servedServiceTier?: string

  // --- outcome ---
  /**
   * Call outcome.
   *
   * | Value            | Meaning                                        |
   * |------------------|------------------------------------------------|
   * | `'ok'`           | Success                                        |
   * | `'api_error'`    | Auth/rate-limit/server/bad-request/unknown     |
   * | `'timeout'`      | Request exceeded timeout                       |
   * | `'aborted'`      | Caller cancelled via AbortSignal               |
   * | `'content_filter'` | Provider refused the call for safety / AUP (Gemini 200-path; xAI 403 overlay) |
   *
   * Pre-attempt refusals (`attemptNumber: 0` — see above) land in these same
   * buckets via the error's `LlmErrorKind`; they are distinguished from a
   * real attempt's outcome only by `attemptNumber: 0`, not by a separate
   * status value.
   */
  status: 'ok' | 'api_error' | 'timeout' | 'aborted' | 'content_filter'
  /** Why the model stopped generating (absent on error). */
  finishReason?: FinishReason
  /** Whether JSON.parse succeeded for a structured-output request. */
  outputParsed?: boolean
  /** Wall-clock latency in milliseconds from dispatch to response. */
  latencyMs: number
  /** Time spent waiting in the configured RateLimiter before provider dispatch. */
  queueDelayMs?: number

  // --- usage (typed hot fields) ---
  /** Total input tokens (includes cached; GROSS). */
  inputTokens?: number
  /** Total output tokens (includes thinking; GROSS). */
  outputTokens?: number
  /** Cached input tokens (subset of `inputTokens`). */
  cachedInputTokens?: number
  /** Internal reasoning tokens (subset of `outputTokens`). */
  thinkingTokens?: number
  /** `inputTokens + outputTokens`, if returned by the provider. */
  totalTokens?: number

  // --- cost (frozen at write time) ---
  /**
   * Total cost in micro-USD.
   * `null` when the model is not priced; `undefined` when cost was not computed.
   */
  costMicroUsd?: number | null
  /** Pricing snapshot identifier (e.g. `"gemini-2026-06-27"`). */
  pricingVersion?: string
  /**
   * Whether `costMicroUsd` is exact (`'exact'`) or approximate or absent
   * (`'estimated'`: a web-search fee that is an upper bound or unknown, an
   * unpriced model or tier, tokens the usage fields do not carry). Present
   * whenever a `Cost` was computed; absent on refusal rows and when the provider
   * has no pricing source.
   */
  costConfidence?: Cost['confidence']
  /**
   * The cost split into lanes in micro-USD (`{ input, cached, output, tools }`,
   * summing to `costMicroUsd`), so tool fees can be separated from token spend
   * in SQL. Present only when the call was priced (`costMicroUsd` is not null).
   */
  costDetails?: Cost['details']
  /**
   * Why the call is unpriced (an unknown model, an unpriced tier or tool
   * counter). Present only when `costMicroUsd` is `null`.
   */
  costUnpricedReason?: string

  // --- forward-compat JSONB lanes ---
  /** Open token-type detail map from `Usage.details` (JSONB). */
  tokenDetails: JsonValue
  /**
   * Raw provider usage object from `Usage.raw` (JSONB).
   *
   * `null` when no provider usage payload exists for this row (error,
   * timeout, aborted, content_filter, or an ADR-025 `attemptNumber: 0`
   * pre-attempt refusal — `EMPTY_USAGE.raw` in `engine.ts`). Persisting `{}`
   * in that case would fabricate a payload the provider never returned, so
   * `null` is preserved end-to-end into `@gullabs/drizzle`'s nullable
   * `raw_usage` column rather than defaulted to an empty object.
   */
  rawUsage: JsonValue
  /**
   * Normalized citations persisted as JSON.
   * Absent when the adapter produced none.
   */
  citations?: Citation[]
  /** Projection of assistant tool-call parts (JSONB). */
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonValue }>
  /**
   * Requested tool names from `LlmRequest.tools` (alongside generationConfig).
   * Present even when the model returned prose and no `toolCalls`.
   */
  toolNames?: string[]
  /** `toolNames.length` when tools were requested. */
  toolCount?: number
  /** Raw provider metadata (grounding, safety ratings, etc.) (JSONB). */
  providerMetadata?: JsonValue
  /** Serialized `Warning[]` (JSONB). */
  warnings?: JsonValue

  // --- generation config ---
  /** Effective generation config sent to the provider (JSONB, transport keys stripped). */
  generationConfig: JsonValue

  // --- reasoning capture (goal 3) ---
  /**
   * Thought-summary text returned by the provider.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned thought text. Truncated by `buildRecord` to
   * {@link RECORD_TEXT_CAP_BYTES} (UTF-8) with a `…[truncated]` marker and a
   * warning; the live result keeps the full text.
   */
  reasoningText?: string

  // --- postmortem (diagnostics on failure) ---
  /** Error kind from the classified `LlmError` (absent on success). */
  errorKind?: LlmErrorKind
  /**
   * Typed reason from the classified `LlmError`, from the closed
   * {@link LlmErrorReason} set. Absent on success and whenever the error
   * carries no reason; `errorKind` stays authoritative.
   */
  errorReason?: LlmErrorReason
  /**
   * Redacted error message (absent on success), truncated by `buildRecord` to
   * {@link RECORD_TEXT_CAP_BYTES} (UTF-8) with a `…[truncated]` marker and a
   * warning; the thrown `LlmError` keeps the full message.
   */
  errorMessage?: string

  // --- host anchors ---
  /** Host-supplied metadata (tenantId, runId, traceId, etc.) (JSONB). */
  metadata: JsonValue
  /** ISO-8601 creation timestamp, stamped by the `Clock` port. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// buildRecord inputs
// ---------------------------------------------------------------------------

/**
 * The engine-internal inputs required to assemble an `LlmCallRecord`.
 */
export interface BuildRecordInput {
  /** Unique call ID. */
  callId: string
  /** Unique attempt ID (idempotency key). */
  attemptId: string
  /** 1-based ordinal of this attempt within the logical call. */
  attemptNumber: number
  /** Optional call-site identifier. */
  callSiteId?: string
  /** Optional caller-owned correlation id. */
  externalId?: string
  /** Opaque attribution label from the resolved auth material's `keyId` (ADR-026). */
  authKeyId?: string
  /** Provider identifier. */
  provider: string
  /** Requested model string. */
  model: string
  /** Provider-returned model version. */
  modelVersion?: string
  /** Provider-assigned response ID. */
  responseId?: string
  /** Service tier used. */
  serviceTier?: string
  /** Service tier actually served by the provider. */
  servedServiceTier?: string
  /** Token usage for the call. */
  usage: Usage
  /** Computed cost (absent when model is unpriced or cost failed). */
  cost?: Cost
  /** Wall-clock latency in milliseconds. */
  latencyMs: number
  /** Time spent waiting in the configured RateLimiter before provider dispatch. */
  queueDelayMs?: number
  /**
   * Call outcome status.
   * The engine computes this from the call result or classified error.
   */
  status: LlmCallRecord['status']
  /** Finish reason (absent on error paths). */
  finishReason?: FinishReason
  /** Whether JSON.parse succeeded for a structured-output request. */
  outputParsed?: boolean
  /** Warnings emitted during the call. */
  warnings?: Warning[]
  /** Effective generation config that was sent to the provider. */
  generationConfig: GenConfig
  /** Host-supplied metadata (JSONB). */
  metadata: JsonValue
  /** ISO-8601 timestamp from the `Clock` port. */
  createdAt: string
  /** Classified error (absent on success). */
  error?: LlmError
  /**
   * Provider thought-summary text.
   * Present when `includeThoughts` was requested and the provider responded.
   */
  reasoningText?: string
  /** Normalized citations from the adapter (absent when unused). */
  citations?: Citation[]
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonValue }>
  toolNames?: string[]
  toolCount?: number
  /** Raw provider metadata (JSONB). */
  providerMetadata?: JsonValue
}

// ---------------------------------------------------------------------------
// Error kind → record status mapping
// ---------------------------------------------------------------------------

/**
 * Maps an `LlmErrorKind` to a record `status`.
 *
 * - `'timeout'`, `'aborted'`, `'content_filter'` are direct.
 * - All other error kinds collapse to `'api_error'`.
 */
function errorKindToStatus(kind: LlmErrorKind): LlmCallRecord['status'] {
  switch (kind) {
    case 'timeout':
      return 'timeout'
    case 'aborted':
      return 'aborted'
    case 'content_filter':
      return 'content_filter'
    case 'invalid_auth':
    case 'rate_limited':
    case 'server':
    case 'bad_request':
    case 'unknown':
      return 'api_error'
    default:
      return assertNever(kind)
  }
}

// Keep the function in scope so it can be used if the engine wants to derive
// status from an error kind without building a full record.
export { errorKindToStatus }

// ---------------------------------------------------------------------------
// Public usage normalizer (thin wrapper around sanitizeUsage for the engine)
// ---------------------------------------------------------------------------

/**
 * Validates and normalises GROSS/subset token invariants.
 *
 * Re-exports the internal {@link sanitizeUsage} logic with a stable public name
 * so the engine can normalise usage exactly once (SPEC step 7) and share the
 * same `Usage` value for the result, cost, and record — no silent divergence.
 *
 * @param usage - Raw usage from the adapter.
 * @returns The clamped `usage` and any `warnings` about violations.
 */
export function normalizeUsage(usage: Usage): {
  usage: Usage
  warnings: Warning[]
  /**
   * `true` when the provider's `totalTokens` is larger than `inputTokens +
   * outputTokens`: it counted tokens the usage fields do not carry (tool-use
   * prompt tokens, say), so a cost computed from the fields can undercount and
   * the engine reports it as `'estimated'`.
   */
  estimated: boolean
} {
  const { usage: normalized, clampWarnings, estimated } = sanitizeUsage(usage)
  return { usage: normalized, warnings: clampWarnings, estimated }
}

// ---------------------------------------------------------------------------
// Usage invariant sanitizer — helpers
// ---------------------------------------------------------------------------

/**
 * Recursively replaces non-finite numbers (NaN, ±Infinity) in a `JsonValue`
 * with `null` so every persisted blob is valid JSON.
 *
 * `JSON.stringify` already coerces non-finite numbers to `null`, but making
 * the replacement explicit before storage means the in-memory `rawUsage` value
 * is consistent with what is written to the database.
 *
 * @param value - Any JSON-compatible value.
 * @returns `{ sanitized, hadNonFinite }` — a safe copy and a changed flag.
 */
function sanitizeRawJson(value: JsonValue): {
  sanitized: JsonValue
  hadNonFinite: boolean
} {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { sanitized: null, hadNonFinite: true }
    return { sanitized: value, hadNonFinite: false }
  }
  if (Array.isArray(value)) {
    let hadNonFinite = false
    const out: JsonValue[] = []
    for (const item of value) {
      const r = sanitizeRawJson(item)
      if (r.hadNonFinite) hadNonFinite = true
      out.push(r.sanitized)
    }
    return { sanitized: hadNonFinite ? out : value, hadNonFinite }
  }
  if (value !== null && typeof value === 'object') {
    let hadNonFinite = false
    const out: { [k: string]: JsonValue } = {}
    for (const [k, v] of Object.entries(value)) {
      const r = sanitizeRawJson(v)
      if (r.hadNonFinite) hadNonFinite = true
      out[k] = r.sanitized
    }
    return { sanitized: hadNonFinite ? out : value, hadNonFinite }
  }
  // null | boolean | string — always JSON-safe.
  return { sanitized: value, hadNonFinite: false }
}

/**
 * Sanitizes the open token-detail map (`Usage.details`).
 *
 * Each value is coerced to a finite non-negative number; non-finite or
 * negative values are replaced with `0` and a warning is pushed.
 *
 * @param details - Raw details map from the adapter.
 * @param warnings - Mutable array to append fix-up warnings into.
 * @returns `{ sanitized, hadFix }` — the sanitized map and a changed flag.
 */
function sanitizeDetails(
  details: Record<string, number>,
  warnings: Warning[],
): { sanitized: Record<string, number>; hadFix: boolean } {
  let hadFix = false
  const sanitized: Record<string, number> = {}
  for (const [key, val] of Object.entries(details)) {
    if (!Number.isFinite(val) || val < 0) {
      warnings.push({
        type: 'other',
        message: `usage.details["${key}"] (${String(
          val,
        )}) is non-finite or negative; clamped to 0`,
      })
      sanitized[key] = 0
      hadFix = true
    } else {
      sanitized[key] = val
    }
  }
  return { sanitized: hadFix ? sanitized : details, hadFix }
}

// ---------------------------------------------------------------------------
// Token clamping helper
// ---------------------------------------------------------------------------

/**
 * Clamps a single token count to a finite non-negative value.
 *
 * Returns `{ value: 0, changed: true }` when the input is non-finite or
 * negative, pushing a warning.  Returns `{ value: val, changed: false }` when
 * the value is already valid.
 */
function clampToken(
  name: string,
  val: number,
  warnings: Warning[],
): { value: number; changed: boolean } {
  if (Number.isFinite(val) && val >= 0) return { value: val, changed: false }
  warnings.push({
    type: 'other',
    message: `${name} (${String(val)}) is non-finite or negative; clamped to 0`,
  })
  return { value: 0, changed: true }
}

// ---------------------------------------------------------------------------
// Usage invariant sanitizer
// ---------------------------------------------------------------------------

/**
 * The result of {@link sanitizeUsage}.
 */
interface SanitizeUsageResult {
  /** Usage with subset token counts clamped to their parent GROSS fields. */
  usage: Usage
  /** Warnings emitted for each violation that was corrected. */
  clampWarnings: Warning[]
  /** `totalTokens` exceeds `inputTokens + outputTokens`: some billed tokens are uncounted. */
  estimated: boolean
}

/**
 * Validates GROSS/subset token invariants and clamps any violations.
 *
 * Per the SPEC:
 * - `cachedInputTokens` **must** be ≤ `inputTokens` (it is a subset of gross input).
 * - `thinkingTokens` **must** be ≤ `outputTokens` (it is a subset of gross output).
 *
 * **Policy (fail-open):** when a subset exceeds its parent we clamp it to the
 * parent value and emit a `Warning` so the anomaly is visible in the persisted
 * record.  We never throw — this runs inside the record-building path where
 * side-effect failures must not abort the call.
 *
 * `totalTokens` is sanity-checked (warn if below `input + output`) but is not
 * clamped because it is provider-reported and informational only.
 */
function sanitizeUsage(usage: Usage): SanitizeUsageResult {
  const warnings: Warning[] = []
  let needsRebuild = false

  // ------------------------------------------------------------------
  // Step A: Clamp non-finite or negative CORE token counts to 0.
  //
  // Defensive against malformed adapter output (NaN, Infinity, negative).
  // Policy (fail-open): clamp + warn, never throw.  The GROSS subset checks
  // below use the clamped values so that downstream cost math never sees NaN.
  // ------------------------------------------------------------------
  // `clampToken` uses Number.isFinite (no coercion) and checks val >= 0.
  // We intentionally check the runtime value even though TypeScript says `number`
  // because malformed adapter output can sneak in undefined/NaN via a cast.
  const inputResult = clampToken('inputTokens', usage.inputTokens, warnings)
  const inputTokens = inputResult.value
  if (inputResult.changed) needsRebuild = true

  const outputResult = clampToken('outputTokens', usage.outputTokens, warnings)
  const outputTokens = outputResult.value
  if (outputResult.changed) needsRebuild = true

  let cachedInputTokens = usage.cachedInputTokens
  let thinkingTokens = usage.thinkingTokens

  // Clamp non-finite or negative SUBSET token counts to 0 before GROSS check.
  if (cachedInputTokens !== undefined) {
    const r = clampToken('cachedInputTokens', cachedInputTokens, warnings)
    if (r.changed) {
      cachedInputTokens = r.value
      needsRebuild = true
    }
  }

  if (thinkingTokens !== undefined) {
    const r = clampToken('thinkingTokens', thinkingTokens, warnings)
    if (r.changed) {
      thinkingTokens = r.value
      needsRebuild = true
    }
  }

  // ------------------------------------------------------------------
  // Step B: GROSS subset invariant checks (uses clamped values from Step A).
  // ------------------------------------------------------------------
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
    warnings.push({
      type: 'other',
      message:
        `cachedInputTokens (${cachedInputTokens}) exceeds inputTokens (${inputTokens}); ` +
        `clamped to ${inputTokens}`,
    })
    cachedInputTokens = inputTokens
    needsRebuild = true
  }

  if (thinkingTokens !== undefined && thinkingTokens > outputTokens) {
    warnings.push({
      type: 'other',
      message:
        `thinkingTokens (${thinkingTokens}) exceeds outputTokens (${outputTokens}); ` +
        `clamped to ${outputTokens}`,
    })
    thinkingTokens = outputTokens
    needsRebuild = true
  }

  let estimated = false
  if (usage.totalTokens !== undefined) {
    const expected = inputTokens + outputTokens
    if (usage.totalTokens < expected) {
      warnings.push({
        type: 'other',
        message:
          `totalTokens (${usage.totalTokens}) is less than ` +
          `inputTokens + outputTokens (${expected}); recorded as-is`,
      })
    } else if (usage.totalTokens > expected) {
      // The provider counted tokens the usage fields do not carry, for example
      // tool-use prompt tokens. A cost built from the fields can undercount.
      estimated = true
      warnings.push({
        type: 'other',
        message:
          `totalTokens (${usage.totalTokens}) is greater than ` +
          `inputTokens + outputTokens (${expected}); the provider counted tokens the ` +
          `usage fields do not include, so cost.confidence is "estimated"`,
      })
    }
  }

  // ------------------------------------------------------------------
  // Step C: Sanitize open details map and raw usage object.
  //
  // details (Record<string,number>): coerce non-finite / negative values to 0.
  // raw (JsonValue): recursively replace non-finite numbers with null so
  // the stored JSONB is always valid and round-trips without silent mutation.
  // ------------------------------------------------------------------
  const { sanitized: sanitizedDetails, hadFix: detailsFixed } = sanitizeDetails(
    usage.details,
    warnings,
  )
  const { sanitized: sanitizedRaw, hadNonFinite: rawFixed } = sanitizeRawJson(usage.raw)

  if (detailsFixed || rawFixed) {
    needsRebuild = true
  }

  if (!needsRebuild) {
    return { usage, clampWarnings: warnings, estimated }
  }

  // Rebuild Usage with clamped values — exactOptionalPropertyTypes-safe.
  const clampedUsage: Usage = {
    inputTokens,
    outputTokens,
    details: sanitizedDetails,
    raw: sanitizedRaw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  }

  return { usage: clampedUsage, clampWarnings: warnings, estimated }
}

// ---------------------------------------------------------------------------
// Text cap
// ---------------------------------------------------------------------------

/**
 * Largest `reasoningText` / `errorMessage` a record carries, in UTF-8 bytes,
 * marker included. Both are provider-controlled and unbounded; a ledger row must
 * not grow with them.
 */
export const RECORD_TEXT_CAP_BYTES = 16 * 1024

const TRUNCATION_MARKER = '…[truncated]'

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/**
 * Caps `text` at {@link RECORD_TEXT_CAP_BYTES} UTF-8 bytes. A longer text is cut
 * at a code-point boundary and ends with `…[truncated]`, so the result never
 * exceeds the cap.
 */
function capRecordText(text: string): { text: string; truncated: boolean } {
  // UTF-16 length * 3 bounds the UTF-8 length from above.
  if (text.length * 3 <= RECORD_TEXT_CAP_BYTES) return { text, truncated: false }
  let total = 0
  for (const ch of text) {
    total += utf8Length(ch.codePointAt(0) as number)
    if (total > RECORD_TEXT_CAP_BYTES) break
  }
  if (total <= RECORD_TEXT_CAP_BYTES) return { text, truncated: false }
  let budget = RECORD_TEXT_CAP_BYTES
  for (const ch of TRUNCATION_MARKER) budget -= utf8Length(ch.codePointAt(0) as number)
  let used = 0
  let end = 0
  for (const ch of text) {
    const bytes = utf8Length(ch.codePointAt(0) as number)
    if (used + bytes > budget) break
    used += bytes
    end += ch.length
  }
  return { text: text.slice(0, end) + TRUNCATION_MARKER, truncated: true }
}

// ---------------------------------------------------------------------------
// Postgres-safe text
// ---------------------------------------------------------------------------

/**
 * Deep copy-on-write {@link cleanText} over every string and object key in a
 * record value. A subtree with nothing to clean is returned as the same
 * object, so the caller's data is never mutated and clean records alias their
 * inputs exactly as before. `changed` is set when anything was cleaned.
 */
export function cleanDeep<T>(value: T, state: { changed: boolean }): T {
  if (typeof value === 'string') {
    const cleaned = cleanText(value)
    if (cleaned !== value) state.changed = true
    return cleaned as T
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    value.forEach((item: unknown, index) => {
      const cleaned = cleanDeep(item, state)
      if (cleaned !== item) {
        copy ??= value.slice()
        copy[index] = cleaned
      }
    })
    return (copy ?? value) as T
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    let copy: Record<string, unknown> | undefined
    entries.forEach(([key, item], index) => {
      const cleanedKey = cleanText(key)
      const cleaned = cleanDeep(item, state)
      if (cleaned !== item || cleanedKey !== key) {
        if (cleanedKey !== key) state.changed = true
        // Rebuild in order so a key that collapses keeps its place.
        copy ??= Object.fromEntries(
          entries.slice(0, index).map(([k, v]) => [k, v] as const),
        )
        setOwn(copy, cleanedKey, cleaned)
      } else if (copy !== undefined) {
        setOwn(copy, key, item)
      }
    })
    return (copy ?? value) as T
  }
  return value
}

const CLEANED_TEXT_WARNING =
  'the ledger record held U+0000 or an unpaired surrogate, which Postgres cannot store; U+0000 was removed and each unpaired surrogate replaced with U+FFFD.'

// ---------------------------------------------------------------------------
// buildRecord
// ---------------------------------------------------------------------------

/**
 * Assembles an `LlmCallRecord` from engine-internal inputs.
 *
 * **Pure function — no I/O.**  The caller is responsible for supplying all
 * fields; the engine calls this after the adapter returns (or throws).
 *
 * Token-usage invariants (`cachedInputTokens ≤ inputTokens`,
 * `thinkingTokens ≤ outputTokens`) are enforced by clamping any violations
 * and appending a `Warning` to the record rather than throwing.  This is the
 * SPEC fail-open policy: persistence is always attempted.
 *
 * Rationale for co-locating mapping logic here: the engine and the drizzle
 * sink are decoupled.  The sink only calls `usageSink.record(r)` — it never
 * knows how the record was assembled.
 *
 * @param input - All fields needed to build the record.
 * @returns An immutable `LlmCallRecord` ready for persistence.
 */
export function buildRecord(input: BuildRecordInput): LlmCallRecord {
  // Derive status from the error kind when an error is present, overriding the
  // caller-supplied status only when it provides more specificity.
  const status: LlmCallRecord['status'] =
    input.error !== undefined ? errorKindToStatus(input.error.kind) : input.status

  // Validate and clamp usage subset invariants (fail-open: clamp + warn).
  const { usage, clampWarnings } = sanitizeUsage(input.usage)

  // Merge caller warnings with any clamp warnings. The engine normalises usage
  // once and passes its warnings in; re-sanitising the same usage must not
  // repeat them.
  const callerWarnings = input.warnings ?? []
  const allWarnings: Warning[] = [
    ...callerWarnings,
    ...clampWarnings.filter(
      (w) => !callerWarnings.some((known) => known.message === w.message),
    ),
  ]

  // Postgres-unsafe text (U+0000, unpaired surrogates) is cleaned BEFORE
  // redaction: a secret split by a NUL (`AIza\0Sy...`) is only recognisable
  // once the NUL is gone, and redacting first would let the strip reassemble it.
  // `state.changed` still drives the record warning.
  const state = { changed: false }
  const clean = (text: string): string => {
    const cleaned = cleanText(text)
    if (cleaned !== text) state.changed = true
    return cleaned
  }

  // Provider-controlled free text is redacted, then capped; the live result and
  // error keep the full text. Redaction runs first so a secret cannot be cut in
  // half and survive as an unrecognisable fragment.
  const reasoning =
    input.reasoningText !== undefined
      ? capRecordText(redactSecrets(clean(input.reasoningText)))
      : undefined
  const errorText =
    input.error !== undefined
      ? capRecordText(redactSecrets(clean(input.error.message)))
      : undefined
  if (reasoning?.truncated === true) {
    allWarnings.push({
      type: 'other',
      message: `reasoningText was truncated to ${RECORD_TEXT_CAP_BYTES} bytes in the ledger record.`,
    })
  }
  if (errorText?.truncated === true) {
    allWarnings.push({
      type: 'other',
      message: `errorMessage was truncated to ${RECORD_TEXT_CAP_BYTES} bytes in the ledger record.`,
    })
  }

  // The model's tool-call arguments are redacted like any stored text: secret
  // patterns in every string, and the value of a key named like a secret.
  const toolCalls =
    input.toolCalls !== undefined && input.toolCalls.length > 0
      ? input.toolCalls.map((call) => ({
          ...call,
          args: redactJsonValue(cleanDeep(call.args, state)) as JsonValue,
        }))
      : undefined

  // C1: Scoped provider extension redaction.
  // Only secret-bearing provider lanes are redacted; all standard generation knobs
  // (temperature, topP, maxOutputTokens, stopSequences, serviceTier, etc.) pass
  // through untouched. We shallow-copy before redacting so the caller's original
  // config object is never mutated.
  let gcMut: Record<string, unknown> = {
    ...(input.generationConfig as unknown as Record<string, unknown>),
  }
  if (gcMut['providerOptions'] !== undefined) {
    gcMut = {
      ...gcMut,
      providerOptions: JSON.parse(
        redactSecrets(JSON.stringify(cleanDeep(gcMut['providerOptions'], state))),
      ) as unknown,
    }
  }
  // Cast GenConfig → JsonValue.
  // GenConfig only contains JSON-serialisable values (numbers, strings, booleans,
  // string arrays, and Record<string, JsonValue>), so this is safe.
  const generationConfig = gcMut as unknown as JsonValue

  // Cast Usage.details → JsonValue.
  // Record<string, number> is a valid JSON object when all values are numbers.
  const tokenDetails = usage.details as unknown as JsonValue

  // Build the record using conditional spreads for every optional property so
  // `exactOptionalPropertyTypes` is satisfied (we never assign `undefined`).
  const record: LlmCallRecord = {
    recordSchemaVersion: 2,
    callId: input.callId,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    ...(input.callSiteId !== undefined ? { callSiteId: input.callSiteId } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.authKeyId !== undefined ? { authKeyId: input.authKeyId } : {}),
    provider: input.provider,
    model: input.model,
    ...(input.modelVersion !== undefined ? { modelVersion: input.modelVersion } : {}),
    ...(input.responseId !== undefined ? { responseId: input.responseId } : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
    ...(input.servedServiceTier !== undefined
      ? { servedServiceTier: input.servedServiceTier }
      : {}),
    status,
    ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
    ...(input.outputParsed !== undefined ? { outputParsed: input.outputParsed } : {}),
    latencyMs: input.latencyMs,
    ...(input.queueDelayMs !== undefined ? { queueDelayMs: input.queueDelayMs } : {}),
    // Usage hot fields — always present since Usage.inputTokens/outputTokens are required.
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.thinkingTokens !== undefined
      ? { thinkingTokens: usage.thinkingTokens }
      : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    // Cost fields — only when a Cost object is present.
    ...(input.cost !== undefined
      ? {
          costMicroUsd: input.cost.microUsd,
          pricingVersion: input.cost.pricingVersion,
          costConfidence: input.cost.confidence,
          ...(input.cost.microUsd !== null ? { costDetails: input.cost.details } : {}),
          ...(input.cost.unpricedReason !== undefined
            ? { costUnpricedReason: input.cost.unpricedReason }
            : {}),
        }
      : {}),
    // JSONB lanes.
    tokenDetails,
    rawUsage: usage.raw,
    ...(input.citations !== undefined && input.citations.length > 0
      ? { citations: input.citations }
      : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(input.toolNames !== undefined && input.toolNames.length > 0
      ? { toolNames: input.toolNames, toolCount: input.toolNames.length }
      : {}),
    ...(input.providerMetadata !== undefined
      ? { providerMetadata: input.providerMetadata }
      : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    generationConfig,
    // Reasoning capture.
    ...(reasoning !== undefined ? { reasoningText: reasoning.text } : {}),
    // Postmortem — only on failure.
    // errorMessage is redacted before persistence so secrets in provider error
    // text (API keys in URLs, Bearer tokens) are not written to the audit record.
    // The live LlmError thrown to the caller is NOT modified.
    ...(input.error !== undefined && errorText !== undefined
      ? {
          errorKind: input.error.kind,
          ...(input.error.reason !== undefined
            ? { errorReason: input.error.reason }
            : {}),
          errorMessage: errorText.text,
        }
      : {}),
    metadata: input.metadata,
    createdAt: input.createdAt,
  }

  // Provider-controlled text can carry what Postgres cannot store; clean the whole
  // record once, last (the free text above was cleaned before redaction).
  const cleaned = cleanDeep(record, state)
  if (!state.changed) return record
  return {
    ...cleaned,
    warnings: [
      ...((cleaned.warnings ?? []) as JsonValue[]),
      { type: 'other', message: CLEANED_TEXT_WARNING },
    ],
  }
}
