/**
 * Opt-in prompt and response storage (ADR-038).
 *
 * `ClientConfig.payloads` turns capture on. For every attempt that reached
 * dispatch, the engine builds one {@link LlmCallPayload} from the request the
 * adapter received and the attempt's outcome, runs it through redaction and the
 * size caps, and hands it to the usage sink next to the ledger record. Nothing
 * here persists anything.
 *
 * Order is fixed and is the contract: (1) core `redactSecrets` on every string
 * leaf, (2) the host's `redact`, (3) the caps, last, so a redactor can never
 * push stored text over the limit.
 *
 * @module
 */

import { canonicalJson } from './canonical-json.js'
import { LlmError } from './errors.js'
import { redactSecrets } from './redact.js'
import { cleanDeep } from './record.js'
import type { Logger } from './ports.js'
import type { JsonValue, LlmRequest, Message, Part, ToolDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One message part as stored. Text is verbatim; tool-call arguments and
 * tool-result values are JSON; an inline media part is its media type, decoded
 * size and SHA-256, never its bytes. Provider-hosted file references keep the
 * reference (a URI or file id), which is not content.
 */
export type StoredPart =
  | { kind: 'text'; text: string }
  | { kind: 'inline-media'; mimeType: string; bytes: number; sha256: string }
  | { kind: 'file-uri'; uri: string; mimeType: string }
  | { kind: 'file-ref'; fileId: string; mimeType?: string }
  | { kind: 'tool-call'; toolCallId: string; toolName: string; args: JsonValue }
  | {
      kind: 'tool-result'
      toolCallId: string
      toolName: string
      result: JsonValue
      isError?: boolean
    }

/** A message as stored: `{ role, parts }`. */
export interface StoredMessage {
  role: 'user' | 'assistant'
  parts: StoredPart[]
}

/** A tool definition as stored: its name and the SHA-256 of its canonical input schema. */
export interface StoredTool {
  name: string
  schemaSha256: string
}

/**
 * What is stored for one attempt: the request the adapter received and the
 * attempt's outcome. Reasoning text and tool calls the model produced are on
 * the `llm_calls` row already and are not repeated here.
 */
export interface LlmCallPayload {
  request: {
    system?: string
    messages: StoredMessage[]
    tools?: StoredTool[]
  }
  response: {
    /** The raw model text, or the raw JSON text of a structured output. */
    text?: string
    /** The attempt's error message, when it failed. */
    errorMessage?: string
  }
}

/**
 * Opt-in payload storage for a client (`ClientConfig.payloads`). Present means
 * on; absent means nothing is captured.
 */
export interface PayloadsConfig {
  /**
   * Runs after core's secret redaction and before the size caps, on a copy the
   * host may change. Return the payload to store. Throwing (or returning
   * something that is not a payload) drops the payload with an
   * `llm.call.payload.dropped` warning; the call is never failed.
   */
  redact?: (payload: LlmCallPayload) => LlmCallPayload
  /**
   * Longest a single stored string may be, in characters. Longer strings are
   * cut and end with `[truncated]`. The whole payload, serialized, is capped at
   * `4 × maxChars`: the largest strings are replaced by a marker until it fits.
   * A positive integer.
   * @default 200000
   */
  maxChars?: number
  /**
   * Called once per attempt with the call's request. Only a return value of
   * exactly `true` captures; `false`, anything else, or a throw skips (a throw
   * also logs `llm.call.payload.dropped`).
   */
  include?: (request: LlmRequest) => boolean
}

/** Second argument of {@link UsageSink.record}. */
export interface UsageSinkContext {
  /** Present only when payload storage is on for this attempt. */
  payload?: LlmCallPayload
  /**
   * The client's logger, for a sink to report a payload problem it recovered
   * from (the Drizzle sink's `llm.call.payload.failed`). Present exactly when
   * `payload` is.
   */
  logger?: Logger
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default for {@link PayloadsConfig.maxChars}. */
export const DEFAULT_PAYLOAD_MAX_CHARS = 200_000

/** Appended to a string cut at `maxChars`. */
export const PAYLOAD_TRUNCATED_MARKER = '[truncated]'

/** Replaces a string dropped to bring the whole payload under `4 × maxChars`. */
export const PAYLOAD_DROPPED_MARKER = '[dropped: over the payload size cap]'

const MAX_DEPTH = 1000

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Rejects an unusable `payloads` config at `createClient`.
 *
 * @throws LlmError `bad_request` naming the offending key.
 */
export function assertPayloadsConfig(config: unknown): asserts config is PayloadsConfig {
  const fail = (path: string, message: string): never => {
    throw new LlmError(`createClient: ${path} ${message}`, {
      kind: 'bad_request',
      retryable: false,
      issues: [{ path, message }],
    })
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    fail('payloads', 'must be an object.')
  }
  const record = config as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'redact' && key !== 'maxChars' && key !== 'include') {
      fail(`payloads.${key}`, 'is not a known option (redact, maxChars, include).')
    }
  }
  if (record['redact'] !== undefined && typeof record['redact'] !== 'function') {
    fail('payloads.redact', 'must be a function.')
  }
  if (record['include'] !== undefined && typeof record['include'] !== 'function') {
    fail('payloads.include', 'must be a function.')
  }
  const maxChars = record['maxChars']
  if (
    maxChars !== undefined &&
    !(
      typeof maxChars === 'number' &&
      Number.isInteger(maxChars) &&
      maxChars >= 1 &&
      Number.isSafeInteger(maxChars * 4)
    )
  ) {
    fail('payloads.maxChars', 'must be a positive integer.')
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** What the engine hands {@link buildPayload}. */
export interface PayloadSource {
  system?: string
  messages: readonly Message[]
  tools?: readonly ToolDefinition[]
}

function hex(bytes: ArrayBuffer): string {
  let out = ''
  for (const b of new Uint8Array(bytes)) out += b.toString(16).padStart(2, '0')
  return out
}

async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

async function storedPart(part: Part): Promise<StoredPart> {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text }
    case 'inline-media': {
      const bytes = decodeBase64(part.data)
      return {
        kind: 'inline-media',
        mimeType: part.mimeType,
        bytes: bytes.length,
        sha256: await sha256Hex(bytes),
      }
    }
    case 'file-uri':
      return { kind: 'file-uri', uri: part.uri, mimeType: part.mimeType }
    case 'file-ref':
      return {
        kind: 'file-ref',
        fileId: part.fileId,
        ...(part.mimeType !== undefined ? { mimeType: part.mimeType } : {}),
      }
    case 'tool-call':
      return {
        kind: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
      }
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.result,
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
      }
  }
}

async function capture(
  source: PayloadSource,
  response: LlmCallPayload['response'],
): Promise<LlmCallPayload> {
  const messages: StoredMessage[] = []
  for (const message of source.messages) {
    const parts: StoredPart[] = []
    for (const part of message.parts) parts.push(await storedPart(part))
    messages.push({ role: message.role, parts })
  }
  let tools: StoredTool[] | undefined
  if (source.tools !== undefined && source.tools.length > 0) {
    tools = []
    for (const tool of source.tools) {
      tools.push({
        name: tool.name,
        schemaSha256: await sha256Hex(canonicalJson(tool.inputJsonSchema)),
      })
    }
  }
  return {
    request: {
      ...(source.system !== undefined ? { system: source.system } : {}),
      messages,
      ...(tools !== undefined ? { tools } : {}),
    },
    response: { ...response },
  }
}

// ---------------------------------------------------------------------------
// Redaction and caps
// ---------------------------------------------------------------------------

/**
 * Returns a copy of `value` with `fn` applied to every string leaf (object
 * keys are left as they are). Always builds new containers, so the result
 * aliases nothing in the request.
 */
function mapStrings(value: unknown, fn: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value)
  if (typeof value !== 'object' || value === null) return value
  if (depth > MAX_DEPTH) throw new Error('payload nesting is deeper than 1000 levels')
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => mapStrings(item, fn, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = mapStrings(item, fn, depth + 1)
  }
  return out
}

function capString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  // Do not cut a surrogate pair in half.
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end) + PAYLOAD_TRUNCATED_MARKER
}

interface Leaf {
  parent: Record<string, unknown> | unknown[]
  key: string | number
  length: number
}

function collectLeaves(value: unknown, out: Leaf[], depth = 0): void {
  if (typeof value !== 'object' || value === null) return
  if (depth > MAX_DEPTH) throw new Error('payload nesting is deeper than 1000 levels')
  const parent = value as Record<string, unknown> | unknown[]
  const entries: Array<[string | number, unknown]> = Array.isArray(parent)
    ? parent.map((item, index) => [index, item])
    : Object.entries(parent)
  for (const [key, item] of entries) {
    if (typeof item === 'string') out.push({ parent, key, length: item.length })
    else collectLeaves(item, out, depth + 1)
  }
}

/**
 * The size caps: every string over `maxChars` is cut, then, when the serialized
 * payload is still over `4 × maxChars`, the largest strings are replaced by a
 * marker until it fits. Throws when it cannot be brought under the cap.
 */
function capPayload(payload: unknown, maxChars: number): LlmCallPayload {
  const perLeaf = mapStrings(payload, (text) => capString(text, maxChars))
  const limit = 4 * maxChars
  let serialized = JSON.stringify(perLeaf)
  // A JSON round trip: what is stored is exactly JSON, whatever the host returned.
  const normalized = JSON.parse(serialized) as unknown
  if (serialized.length <= limit) return normalized as LlmCallPayload

  const leaves: Leaf[] = []
  collectLeaves(normalized, leaves)
  leaves.sort((a, b) => b.length - a.length)
  const markerSize = JSON.stringify(PAYLOAD_DROPPED_MARKER).length
  let size = serialized.length
  for (const leaf of leaves) {
    if (size <= limit) break
    const current = (leaf.parent as Record<string | number, unknown>)[leaf.key] as string
    const saved = JSON.stringify(current).length - markerSize
    if (saved <= 0) break
    ;(leaf.parent as Record<string | number, unknown>)[leaf.key] = PAYLOAD_DROPPED_MARKER
    size -= saved
  }
  serialized = JSON.stringify(normalized)
  if (serialized.length > limit) {
    throw new Error(
      `the payload is ${serialized.length} characters after dropping every large string; the cap is ${limit}`,
    )
  }
  return normalized as LlmCallPayload
}

function assertPayloadShape(value: unknown): asserts value is LlmCallPayload {
  const record = value as { request?: unknown; response?: unknown } | null
  const isObject = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (
    !isObject(record) ||
    !isObject(record?.request) ||
    !Array.isArray((record?.request as { messages?: unknown }).messages) ||
    !isObject(record?.response)
  ) {
    throw new Error(
      'the redact function must return a payload ({ request: { messages }, response })',
    )
  }
}

/**
 * Builds the payload for one attempt: capture, redact (core, then the host),
 * cap, and make it Postgres-safe text. Any failure throws; the engine turns a
 * throw into a dropped payload and a warning.
 */
export async function buildPayload(
  source: PayloadSource,
  response: LlmCallPayload['response'],
  config: PayloadsConfig,
): Promise<LlmCallPayload> {
  const maxChars = config.maxChars ?? DEFAULT_PAYLOAD_MAX_CHARS
  const captured = await capture(source, response)
  // (1) core's patterns on every string leaf, nested tool arguments and results included
  let payload = mapStrings(captured, redactSecrets) as LlmCallPayload
  // (2) the host's redactor, on our copy
  if (config.redact !== undefined) {
    const redacted: unknown = config.redact(payload)
    if (
      typeof redacted === 'object' &&
      redacted !== null &&
      typeof (redacted as { then?: unknown }).then === 'function'
    ) {
      throw new Error('the redact function must be synchronous')
    }
    assertPayloadShape(redacted)
    payload = redacted
  }
  // (3) the caps, last; then U+0000 and unpaired surrogates, which Postgres cannot store
  const capped = capPayload(payload, maxChars)
  return cleanDeep(capped, { changed: false })
}
