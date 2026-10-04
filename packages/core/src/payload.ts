/**
 * Opt-in prompt and response storage (ADR-038).
 *
 * `ClientConfig.payloads` turns capture on. For every attempt that reached
 * dispatch, the engine snapshots the request the adapter received at dispatch,
 * and, once the attempt's outcome is known and inside the bounded sink write,
 * builds one {@link LlmCallPayload} from the snapshot and the outcome, runs it
 * through redaction and the size caps, and hands it to the usage sink next to
 * the ledger record. Nothing here persists anything.
 *
 * The order is fixed and is the contract. For every string in the payload:
 * (1) U+0000 and unpaired surrogates are stripped, (2) the string is cut to
 * `maxChars + 256` characters (at a token edge, so a half-cut secret does not
 * survive), which bounds all later work, (3) core's secret patterns run, (4) the
 * host's `redact` runs on the whole payload, (5) the caps run, last, then
 * U+0000 and surrogates are stripped once more because a host redactor can add
 * them. A secret split by U+0000 is therefore redacted whole.
 *
 * @module
 */

import { canonicalJson } from './canonical-json.js'
import { LlmError } from './errors.js'
import { isThenable } from './host-guard.js'
import { cleanText, redactJsonValue, redactSecrets, setOwn } from './redact.js'
import { cleanDeep } from './record.js'
import { Sha256, sha256Hex } from './sha256.js'
import type { Logger } from './ports.js'
import type { JsonValue, LlmRequest, Message, Part, ToolDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One message part as stored. Text is verbatim; tool-call arguments and
 * tool-result values are JSON; an inline media part is its media type, decoded
 * size and SHA-256, never its bytes. A provider-hosted file reference keeps its
 * reference: a `file-uri` without its userinfo, query string and fragment (a
 * signed URL is a credential), a `file-ref` as its id.
 */
export type StoredPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'inline-media'
      mimeType: string
      /** Decoded size in bytes; `null` when the data was not valid base64. */
      bytes: number | null
      /** `null` when the part was skipped (`skipped` says why). */
      sha256: string | null
      /**
       * Present when the part was not hashed: `too_large` (decoded size over
       * {@link PAYLOAD_MAX_INLINE_MEDIA_BYTES}) or `invalid_base64`.
       */
      skipped?: 'too_large' | 'invalid_base64'
    }
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
 * the `llm_calls` row, redacted, and are not repeated here.
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
   * host may change. Return the payload to store. Must be synchronous: an
   * `async` function is `bad_request` at `createClient`, and a Promise returned
   * at run time drops the payload. Throwing (or returning something that is
   * not a payload) drops the payload with an `llm.call.payload.dropped`
   * warning; the call is never failed. A synchronous redactor cannot be
   * interrupted: keep it fast.
   */
  redact?: (payload: LlmCallPayload) => LlmCallPayload
  /**
   * Longest a single stored string may be, in characters. Longer strings are
   * cut and end with `[truncated]`. The whole payload, serialized, is capped at
   * `4 × maxChars`: the largest strings, then the largest tool arguments and
   * results, are replaced by a marker until it fits. An integer of at least
   * 1,000.
   * @default 200000
   */
  maxChars?: number
  /**
   * Called once per attempt, at dispatch, with the call's request. Only a
   * return value of exactly `true` captures; `false`, anything else, or a
   * throw skips (a throw also logs `llm.call.payload.dropped`). Must be
   * synchronous: an `async` function is `bad_request` at `createClient`, and a
   * Promise returned at run time skips with a warning.
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

/** Smallest accepted {@link PayloadsConfig.maxChars}: below it the JSON skeleton alone does not fit. */
export const MIN_PAYLOAD_MAX_CHARS = 1000

/** Appended to a string cut at `maxChars`. */
export const PAYLOAD_TRUNCATED_MARKER = '[truncated]'

/** Replaces a string or JSON value dropped to bring the whole payload under `4 × maxChars`. */
export const PAYLOAD_DROPPED_MARKER = '[dropped: over the payload size cap]'

/**
 * Largest decoded inline media part that is hashed. A larger part is stored as
 * `{ mimeType, bytes, sha256: null, skipped: 'too_large' }`.
 */
export const PAYLOAD_MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024

/** A string is cut to `maxChars` plus this much before any pattern runs on it. */
const PRECAP_SLACK = 256

/** Base64 characters hashed per step (a multiple of 4). */
const MEDIA_CHUNK_CHARS = 1_048_576

/**
 * Work units (characters scanned or base64 characters hashed) between two yields to the event
 * loop. The hash in `sha256.ts` runs at about 7 ms per MiB of decoded bytes (about 18 times
 * slower than `node:crypto`, measured on Node 24), so 2 MiB of base64 (1.5 MiB decoded) is a
 * stretch of about 10 ms without a yield.
 */
const YIELD_EVERY = 2_097_152

const MAX_DEPTH = 1000

/** Longest `uri` kept after its query string and fragment are removed. */
const MAX_URI_CHARS = 2048

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Where a payload was dropped; the engine logs it. */
export type PayloadStage = 'include' | 'snapshot' | 'redact' | 'cap' | 'timeout' | 'build'

/**
 * A payload that could not be built. `message` is a fixed sentence that never
 * contains the payload or the text of a host function's error, so it is safe to
 * log; `causeName` is the class name of the underlying error.
 */
export class PayloadDropped extends Error {
  override readonly name = 'PayloadDropped'
  readonly stage: PayloadStage
  readonly causeName: string | undefined
  constructor(stage: PayloadStage, message: string, cause?: unknown) {
    super(message)
    this.stage = stage
    this.causeName =
      cause instanceof Error ? cause.name : cause === undefined ? undefined : typeof cause
  }
}

/** The stage, error name and fixed message to log for any error from payload building. */
export function describePayloadError(error: unknown): {
  stage: PayloadStage
  errorName: string
  reason: string
} {
  if (error instanceof PayloadDropped) {
    return {
      stage: error.stage,
      errorName: error.causeName ?? error.name,
      reason: error.message,
    }
  }
  return {
    stage: 'build',
    errorName: error instanceof Error ? error.name : typeof error,
    reason: 'the payload could not be built',
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function isAsyncFunction(fn: unknown): boolean {
  const tag = Object.prototype.toString.call(fn)
  return tag === '[object AsyncFunction]' || tag === '[object AsyncGeneratorFunction]'
}

/**
 * Validates `config` and returns a frozen copy, so a later change to the
 * caller's object cannot bypass the checks.
 *
 * @throws LlmError `bad_request` naming the offending key.
 */
export function resolvePayloadsConfig(config: unknown): Readonly<PayloadsConfig> {
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
  for (const key of ['redact', 'include'] as const) {
    const fn = record[key]
    if (fn === undefined) continue
    if (typeof fn !== 'function') fail(`payloads.${key}`, 'must be a function.')
    if (isAsyncFunction(fn)) {
      fail(`payloads.${key}`, 'must be synchronous; an async function is not accepted.')
    }
  }
  const maxChars = record['maxChars']
  if (
    maxChars !== undefined &&
    !(
      typeof maxChars === 'number' &&
      Number.isInteger(maxChars) &&
      maxChars >= MIN_PAYLOAD_MAX_CHARS &&
      Number.isSafeInteger(maxChars * 4)
    )
  ) {
    fail('payloads.maxChars', `must be an integer of at least ${MIN_PAYLOAD_MAX_CHARS}.`)
  }
  return Object.freeze({
    ...(record['redact'] !== undefined
      ? { redact: record['redact'] as PayloadsConfig['redact'] & object }
      : {}),
    ...(maxChars !== undefined ? { maxChars: maxChars as number } : {}),
    ...(record['include'] !== undefined
      ? { include: record['include'] as PayloadsConfig['include'] & object }
      : {}),
  })
}

// ---------------------------------------------------------------------------
// Snapshot (taken at dispatch)
// ---------------------------------------------------------------------------

/** What the engine hands {@link snapshotPayloadSource}. */
export interface PayloadSource {
  system?: string
  messages: readonly Message[]
  tools?: readonly ToolDefinition[]
}

/**
 * A copy of the request as dispatched. Strings are immutable and shared; every
 * container is new and tool-call arguments and tool-result values are deep
 * copies, so a host that changes its request while the call is in flight
 * changes nothing stored. Media data is not copied (it is a string).
 */
export interface PayloadSnapshot {
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; parts: Part[] }>
  tools?: Array<{ name: string; schemaJson: string }>
}

function snapshotPart(part: Part): Part {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text }
    case 'inline-media':
      return { kind: 'inline-media', mimeType: part.mimeType, data: part.data }
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
        args: structuredClone(part.args),
      }
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: structuredClone(part.result),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
      }
  }
}

/**
 * Snapshots `source` synchronously.
 *
 * @throws PayloadDropped (`snapshot`) when the request cannot be copied.
 */
export function snapshotPayloadSource(source: PayloadSource): PayloadSnapshot {
  try {
    return {
      ...(source.system !== undefined ? { system: source.system } : {}),
      messages: source.messages.map((message) => ({
        role: message.role,
        parts: message.parts.map(snapshotPart),
      })),
      ...(source.tools !== undefined && source.tools.length > 0
        ? {
            tools: source.tools.map((tool) => ({
              name: tool.name,
              schemaJson: canonicalJson(tool.inputJsonSchema),
            })),
          }
        : {}),
    }
  } catch (error) {
    throw new PayloadDropped('snapshot', 'the request could not be copied', error)
  }
}

// ---------------------------------------------------------------------------
// Build control: yields and cancellation
// ---------------------------------------------------------------------------

/** How {@link buildPayload} yields the event loop and learns it was abandoned. */
export interface BuildControl {
  /** Resolves on a later turn of the event loop (the client's scheduler `setTimeout(…, 0)`). */
  yieldNow: () => Promise<void>
  /** True once the sink write that wanted the payload was abandoned. */
  cancelled: () => boolean
}

class Meter {
  private work = 0
  private readonly control: BuildControl
  constructor(control: BuildControl) {
    this.control = control
  }
  /** Counts `units` of work; yields to the event loop every {@link YIELD_EVERY}. */
  async spend(units: number): Promise<void> {
    this.work += units
    if (this.work >= YIELD_EVERY) {
      this.work = 0
      await this.control.yieldNow()
    }
    if (this.control.cancelled()) {
      throw new PayloadDropped(
        'timeout',
        'the sink write was abandoned while the payload was built',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const BASE64_BODY_RE = /^[A-Za-z0-9+/]*$/

/** Decode base64 (padding optional, alphabet already checked) without `Buffer`. */
function decodeBase64(chunk: string): Uint8Array {
  const binary = atob(chunk)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Hashes inline media in {@link MEDIA_CHUNK_CHARS} steps and yields to the event loop
 * every {@link YIELD_EVERY} characters (about 10 ms of work), so a large part holds it
 * for short stretches, not for the whole hash. Memory: the base64 string
 * is the request's own; each step adds one decoded chunk of about 768 KiB, so a
 * part costs about 1 MiB extra at any moment, not a full decoded copy.
 */
async function mediaPart(
  part: Extract<Part, { kind: 'inline-media' }>,
  meter: Meter,
): Promise<StoredPart> {
  const data = part.data
  let padding = 0
  while (padding < 2 && data.charCodeAt(data.length - 1 - padding) === 0x3d) padding += 1
  const body = data.length - padding
  const invalid: StoredPart = {
    kind: 'inline-media',
    mimeType: part.mimeType,
    bytes: null,
    sha256: null,
    skipped: 'invalid_base64',
  }
  if (body % 4 === 1 || (padding > 0 && data.length % 4 !== 0)) return invalid
  const bytes = Math.floor((body * 3) / 4)
  if (bytes > PAYLOAD_MAX_INLINE_MEDIA_BYTES) {
    return {
      kind: 'inline-media',
      mimeType: part.mimeType,
      bytes,
      sha256: null,
      skipped: 'too_large',
    }
  }
  const hash = new Sha256()
  for (let from = 0; from < body; from += MEDIA_CHUNK_CHARS) {
    const chunk = data.slice(from, Math.min(from + MEDIA_CHUNK_CHARS, body))
    if (!BASE64_BODY_RE.test(chunk)) return invalid
    hash.update(decodeBase64(chunk))
    await meter.spend(chunk.length)
  }
  return {
    kind: 'inline-media',
    mimeType: part.mimeType,
    bytes,
    sha256: hash.hex(),
  }
}

/**
 * A `file-uri` without userinfo, query string and fragment: a signed URL is a
 * credential. A URI that is not hierarchical (`data:`) keeps only its scheme.
 */
function storableUri(uri: string): string {
  const cleaned = cleanText(uri.slice(0, MAX_URI_CHARS * 8))
  try {
    const url = new URL(cleaned)
    if (!cleaned.slice(url.protocol.length).startsWith('//')) {
      return `${url.protocol}[stripped]`
    }
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, MAX_URI_CHARS)
  } catch {
    const cut = cleaned.search(/[?#]/)
    const noQuery = cut === -1 ? cleaned : cleaned.slice(0, cut)
    return noQuery.replace(/\/\/[^/@]*@/, '//').slice(0, MAX_URI_CHARS)
  }
}

/** Tool arguments and results: a copy in which the value of a secret-named key is replaced. */
function jsonCopy(value: JsonValue): JsonValue {
  return redactJsonValue(value, (text) => text) as JsonValue
}

async function storedPart(part: Part, meter: Meter): Promise<StoredPart> {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text }
    case 'inline-media':
      return mediaPart(part, meter)
    case 'file-uri':
      return { kind: 'file-uri', uri: storableUri(part.uri), mimeType: part.mimeType }
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
        args: jsonCopy(part.args),
      }
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: jsonCopy(part.result),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
      }
  }
}

async function capture(
  snapshot: PayloadSnapshot,
  response: LlmCallPayload['response'],
  meter: Meter,
): Promise<LlmCallPayload> {
  const messages: StoredMessage[] = []
  for (const message of snapshot.messages) {
    const parts: StoredPart[] = []
    for (const part of message.parts) parts.push(await storedPart(part, meter))
    messages.push({ role: message.role, parts })
  }
  const tools: StoredTool[] | undefined = snapshot.tools?.map((tool) => ({
    name: tool.name,
    schemaSha256: sha256Hex(tool.schemaJson),
  }))
  return {
    request: {
      ...(snapshot.system !== undefined ? { system: snapshot.system } : {}),
      messages,
      ...(tools !== undefined ? { tools } : {}),
    },
    response: { ...response },
  }
}

// ---------------------------------------------------------------------------
// Per-string protection: strip, cut, redact
// ---------------------------------------------------------------------------

function isDelimiter(code: number): boolean {
  // whitespace and the characters that end a URL value or a quoted token
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x26 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x2c ||
    code === 0x3b
  )
}

/** Cuts `text` to `end` characters without splitting a surrogate pair. */
function cutAt(text: string, end: number): string {
  let to = end
  const last = text.charCodeAt(to - 1)
  if (last >= 0xd800 && last <= 0xdbff) to -= 1
  return text.slice(0, to)
}

/**
 * Strips U+0000, bounds the string, redacts it, and returns the text to store.
 * A string longer than `maxChars + 256` is cut there first (so the redaction
 * work is bounded), the unbroken token at the cut edge is dropped (a secret cut
 * in half has no recognisable pattern left), the rest is redacted, and the
 * result ends with the truncation marker.
 */
function protectString(raw: string, maxChars: number): string {
  const window = maxChars + PRECAP_SLACK
  const wasCut = raw.length > window
  let text = cleanText(wasCut ? cutAt(raw, window) : raw)
  if (wasCut) {
    let edge = text.length - 1
    const floor = Math.max(0, text.length - PRECAP_SLACK)
    while (edge >= floor && !isDelimiter(text.charCodeAt(edge))) edge -= 1
    // keep the delimiter; with none in the last 256 characters, drop all 256
    text = edge >= floor ? text.slice(0, edge + 1) : text.slice(0, floor)
  }
  text = redactSecrets(text)
  if (wasCut) {
    if (text.length > maxChars) text = cutAt(text, maxChars)
    return text + PAYLOAD_TRUNCATED_MARKER
  }
  return text
}

interface Slot {
  parent: Record<string, unknown> | unknown[]
  key: string | number
}

function collectSlots(value: unknown, out: Slot[], depth = 0): void {
  if (typeof value !== 'object' || value === null) return
  if (depth > MAX_DEPTH) {
    throw new PayloadDropped('build', 'the payload nests deeper than 1000 levels')
  }
  const parent = value as Record<string, unknown> | unknown[]
  const entries: Array<[string | number, unknown]> = Array.isArray(parent)
    ? parent.map((item, index) => [index, item])
    : Object.entries(parent)
  for (const [key, item] of entries) {
    if (typeof item === 'string') out.push({ parent, key })
    else collectSlots(item, out, depth + 1)
  }
}

function writeSlot(slot: Slot, value: string): void {
  if (Array.isArray(slot.parent)) slot.parent[slot.key as number] = value
  else setOwn(slot.parent, slot.key as string, value)
}

function readSlot(slot: Slot): string {
  return (slot.parent as Record<string | number, unknown>)[slot.key] as string
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Cuts a string over `maxChars`; a string that already ends in the marker is left alone. */
function capString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (
    text.length <= maxChars + PAYLOAD_TRUNCATED_MARKER.length &&
    text.endsWith(PAYLOAD_TRUNCATED_MARKER)
  ) {
    return text
  }
  return cutAt(text, maxChars) + PAYLOAD_TRUNCATED_MARKER
}

function capStrings(value: unknown, maxChars: number, depth = 0): unknown {
  if (typeof value === 'string') return capString(value, maxChars)
  if (typeof value !== 'object' || value === null) return value
  if (depth > MAX_DEPTH) {
    throw new PayloadDropped('cap', 'the payload nests deeper than 1000 levels')
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => capStrings(item, maxChars, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    setOwn(out, key, capStrings(item, maxChars, depth + 1))
  }
  return out
}

interface Leaf {
  slot: Slot
  length: number
}

/** JSON values that may be replaced whole: tool-call arguments and tool-result values. */
function jsonRoots(
  payload: unknown,
): Array<{ holder: Record<string, unknown>; key: string }> {
  const out: Array<{ holder: Record<string, unknown>; key: string }> = []
  const messages = (payload as { request?: { messages?: unknown } } | null)?.request
    ?.messages
  if (!Array.isArray(messages)) return out
  for (const message of messages as unknown[]) {
    const parts = (message as { parts?: unknown } | null)?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts as unknown[]) {
      if (typeof part !== 'object' || part === null) continue
      const holder = part as Record<string, unknown>
      const key =
        holder['kind'] === 'tool-call'
          ? 'args'
          : holder['kind'] === 'tool-result'
            ? 'result'
            : undefined
      if (key !== undefined && typeof holder[key] === 'object' && holder[key] !== null) {
        out.push({ holder, key })
      }
    }
  }
  return out
}

/**
 * The size caps: every string over `maxChars` is cut; then, when the serialized
 * payload is still over `4 × maxChars`, the largest strings are replaced by a
 * marker until it fits, and, when only large non-string values are left (a big
 * numeric array in a tool argument), the largest tool arguments and results
 * are replaced too. Throws when it cannot be brought under the cap.
 */
function capPayload(payload: unknown, maxChars: number): LlmCallPayload {
  const perLeaf = capStrings(payload, maxChars)
  const limit = 4 * maxChars
  let serialized = JSON.stringify(perLeaf)
  // A JSON round trip: what is stored is exactly JSON, whatever the host returned.
  const normalized = JSON.parse(serialized) as unknown
  if (serialized.length <= limit) return normalized as LlmCallPayload

  const slots: Slot[] = []
  collectSlots(normalized, slots)
  const leaves: Leaf[] = slots.map((slot) => ({ slot, length: readSlot(slot).length }))
  leaves.sort((a, b) => b.length - a.length)
  const markerSize = JSON.stringify(PAYLOAD_DROPPED_MARKER).length
  let size = serialized.length
  for (const leaf of leaves) {
    if (size <= limit) break
    const saved = JSON.stringify(readSlot(leaf.slot)).length - markerSize
    if (saved <= 0) break
    writeSlot(leaf.slot, PAYLOAD_DROPPED_MARKER)
    size -= saved
  }
  serialized = JSON.stringify(normalized)
  if (serialized.length > limit) {
    const roots = jsonRoots(normalized)
      .map((root) => ({ ...root, length: JSON.stringify(root.holder[root.key]).length }))
      .sort((a, b) => b.length - a.length)
    for (const root of roots) {
      if (serialized.length <= limit) break
      if (root.length <= markerSize) break
      setOwn(root.holder, root.key, PAYLOAD_DROPPED_MARKER)
      serialized = JSON.stringify(normalized)
    }
  }
  if (serialized.length > limit) {
    throw new PayloadDropped(
      'cap',
      'the payload is over the size cap after every large value was dropped',
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
    throw new PayloadDropped(
      'redact',
      'the redact function must return a payload ({ request: { messages }, response })',
    )
  }
}

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

/**
 * Builds the payload for one attempt from its dispatch snapshot and outcome:
 * capture, strip and bound every string, redact (core, then the host), cap, and
 * make it Postgres-safe text. Yields to the event loop between steps of a large
 * payload and stops when `control.cancelled()`. Any failure throws a
 * {@link PayloadDropped}; the engine turns it into a dropped payload and a
 * warning.
 */
export async function buildPayload(
  snapshot: PayloadSnapshot,
  response: LlmCallPayload['response'],
  config: PayloadsConfig,
  control: BuildControl,
): Promise<LlmCallPayload> {
  const maxChars = config.maxChars ?? DEFAULT_PAYLOAD_MAX_CHARS
  const meter = new Meter(control)
  const captured = await capture(snapshot, response, meter)
  // (1)-(3) every string leaf: strip U+0000, cut to maxChars + 256, redact
  const slots: Slot[] = []
  collectSlots(captured, slots)
  for (const slot of slots) {
    const raw = readSlot(slot)
    // The cut bounds the scan; five patterns' worth of passes over it.
    await meter.spend(Math.min(raw.length, maxChars + PRECAP_SLACK) * 5)
    writeSlot(slot, protectString(raw, maxChars))
  }
  let payload: LlmCallPayload = captured
  // (4) the host's redactor, on our copy
  if (config.redact !== undefined) {
    let redacted: unknown
    try {
      redacted = config.redact(payload)
    } catch (error) {
      throw new PayloadDropped('redact', 'the redact function threw', error)
    }
    if (isThenable(redacted)) {
      void Promise.resolve(redacted).catch(() => {})
      throw new PayloadDropped('redact', 'the redact function must be synchronous')
    }
    assertPayloadShape(redacted)
    payload = redacted
  }
  if (control.cancelled()) {
    throw new PayloadDropped(
      'timeout',
      'the sink write was abandoned while the payload was built',
    )
  }
  // (5) the caps, last; then U+0000 and unpaired surrogates again, which Postgres
  // cannot store and a host redactor can add
  const capped = capPayload(payload, maxChars)
  return cleanDeep(capped, { changed: false })
}
