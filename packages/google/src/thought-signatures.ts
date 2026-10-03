/**
 * Gemini 3 thought signatures as an overlay on the host's actual history.
 *
 * Gemini 3.x returns an opaque `thoughtSignature` on the first function call of
 * each model turn (and sometimes on text parts) and rejects a replayed turn
 * whose function call has lost it. The library never keeps a copy of the
 * history. `result.transientProviderState` is only an overlay saying which part
 * of the host's own messages gets which signature:
 *
 * ```ts
 * { google: { signatures: [{ messageIndex, partIndex, kind, model, partSha256, signature }] } }
 * ```
 *
 * `messageIndex` indexes the messages the adapter receives (`request.messages`
 * as the engine hands them on, after any middleware), `partIndex` indexes that
 * message's `parts` (thought parts are never in a message), `kind` is the part
 * kind that was signed (`'text'` or `'tool-call'`), `model` is the model string
 * the request named, and `partSha256` is the SHA-256 of the part's RFC 8785
 * canonical JSON, so an edited argument or text is detected and key order
 * (Postgres `jsonb`) does not matter.
 *
 * A function-call signature is required on replay, so a stale one is
 * `bad_request`. A text signature is optional (Google accepts the next turn
 * without it), so a stale one (edited, moved, removed, or issued for another
 * model) is dropped with a warning and nothing else is lost.
 *
 * @module
 */

import { createHash } from 'node:crypto'

import { LlmError, canonicalJson } from '@gullabs/core'
import type { JsonValue, Message, Part } from '@gullabs/core'

/** The part kinds Google signs. */
export type GoogleSignedKind = 'text' | 'tool-call'

/** One signature, pinned to a part of the host's history. */
export type GoogleSignatureEntry = {
  messageIndex: number
  partIndex: number
  /** The kind of part that was signed; decides whether a stale entry is fatal. */
  kind: GoogleSignedKind
  model: string
  partSha256: string
  signature: string
}

/** The shape of `transientProviderState` for Gemini 3.x models. */
export type GoogleSignatureState = {
  google: { signatures: GoogleSignatureEntry[] }
}

const STATE_PATH = 'transientProviderState'
const SHA256_HEX = /^[0-9a-f]{64}$/
const ENTRY_KEYS = new Set([
  'messageIndex',
  'partIndex',
  'kind',
  'model',
  'partSha256',
  'signature',
])

function badState(path: string, why: string): LlmError {
  return new LlmError(`${path}: ${why}`, {
    kind: 'bad_request',
    retryable: false,
    provider: 'google',
    issues: [{ path, message: why }],
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The JSON a part is hashed as. Only the parts Google signs are admitted: text,
 * and tool calls (id, name and arguments).
 */
function hashedForm(part: Part, path: string): JsonValue {
  switch (part.kind) {
    case 'text':
      return { kind: 'text', text: part.text }
    case 'tool-call':
      return {
        kind: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
      }
    default:
      throw badState(
        path,
        `a thought signature cannot be attached to a "${part.kind}" part`,
      )
  }
}

/** SHA-256 (lowercase hex) of the part's RFC 8785 canonical JSON. */
export function partSha256(part: Part, path = 'part'): string {
  return sha256Hex(canonicalJson(hashedForm(part, path)))
}

/** Strictly parse `transientProviderState` for a Gemini 3.x request. */
export function parseSignatureState(value: unknown): GoogleSignatureEntry[] {
  if (value === undefined) return []
  if (!isRecord(value)) {
    throw badState(STATE_PATH, 'must be { google: { signatures: [...] } }')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'google') {
      throw badState(
        `${STATE_PATH}.${key}`,
        `holds another provider's state; Google state is { google: { signatures: [...] } }`,
      )
    }
  }
  const google = value['google']
  if (!isRecord(google)) {
    throw badState(`${STATE_PATH}.google`, 'must be { signatures: [...] }')
  }
  for (const key of Object.keys(google)) {
    if (key !== 'signatures') {
      throw badState(`${STATE_PATH}.google.${key}`, 'is not a known key')
    }
  }
  const list = google['signatures']
  if (!Array.isArray(list)) {
    throw badState(`${STATE_PATH}.google.signatures`, 'must be an array')
  }
  return list.map((raw, index) => {
    const path = `${STATE_PATH}.google.signatures.${index}`
    if (!isRecord(raw)) throw badState(path, 'must be an object')
    for (const key of Object.keys(raw)) {
      if (!ENTRY_KEYS.has(key)) throw badState(`${path}.${key}`, 'is not a known key')
    }
    const { messageIndex, partIndex, kind, model, partSha256: digest, signature } = raw
    if (
      typeof messageIndex !== 'number' ||
      !Number.isInteger(messageIndex) ||
      messageIndex < 0
    ) {
      throw badState(`${path}.messageIndex`, 'must be a non-negative integer')
    }
    if (typeof partIndex !== 'number' || !Number.isInteger(partIndex) || partIndex < 0) {
      throw badState(`${path}.partIndex`, 'must be a non-negative integer')
    }
    if (kind !== 'text' && kind !== 'tool-call') {
      throw badState(`${path}.kind`, 'must be "text" or "tool-call"')
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw badState(`${path}.model`, 'must be a non-empty string')
    }
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      throw badState(`${path}.partSha256`, 'must be 64 lowercase hex characters')
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw badState(`${path}.signature`, 'must be a non-empty string')
    }
    return { messageIndex, partIndex, kind, model, partSha256: digest, signature }
  })
}

const STALE =
  'history was edited, reordered or produced by another model after the signature was issued'

/** What {@link resolveSignatures} found in the overlay. */
export interface ResolvedSignatures {
  /** `"messageIndex:partIndex"` to signature, for the entries that verified. */
  bySlot: Map<string, string>
  /** The entries that verified, in order: the overlay to carry forward. */
  kept: GoogleSignatureEntry[]
  /** One line per text entry that was dropped as stale. */
  dropped: string[]
}

/**
 * Check the overlay against the host's messages. An entry verifies when it
 * names an assistant message and a part whose hash matches, issued for the
 * model this request names. A stale **text** entry (any of those fail) is
 * dropped and reported in `dropped`: Google treats text signatures as optional.
 * A stale **function-call** entry, a duplicate, or a hash that cannot be
 * computed (a host part outside the JSON domain) is `bad_request`. Then every
 * assistant message that replays tool calls must have an entry for its first
 * tool-call part: Google signs only the first function call of a model turn,
 * and rejects the turn without it.
 */
export function resolveSignatures(
  entries: readonly GoogleSignatureEntry[],
  messages: readonly Message[],
  model: string,
): ResolvedSignatures {
  const bySlot = new Map<string, string>()
  const kept: GoogleSignatureEntry[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const [index, entry] of entries.entries()) {
    const path = `${STATE_PATH}.google.signatures.${index}`
    const slot = `${entry.messageIndex}:${entry.partIndex}`
    const where = `messages.${entry.messageIndex}.parts.${entry.partIndex}`
    /** A stale entry: fatal for a function call, dropped for text. */
    const stale = (field: string, why: string): void => {
      if (entry.kind === 'tool-call') throw badState(`${path}.${field}`, why)
      dropped.push(`${where}: ${why}`)
    }

    if (seen.has(slot)) throw badState(path, `duplicates the entry for ${where}`)
    seen.add(slot)
    if (entry.model !== model) {
      stale(
        'model',
        `was issued for model "${entry.model}" but this request names "${model}"; signatures are not replayed across models (${STALE})`,
      )
      continue
    }
    const message = messages[entry.messageIndex]
    if (message === undefined || message.role !== 'assistant') {
      stale(
        'messageIndex',
        `does not point at an assistant message in messages (${STALE})`,
      )
      continue
    }
    const part = message.parts[entry.partIndex]
    if (part === undefined) {
      stale('partIndex', `is out of range for the message (${STALE})`)
      continue
    }
    if (part.kind !== entry.kind) {
      stale(
        'kind',
        `is for a "${entry.kind}" part but ${where} is a "${part.kind}" part (${STALE})`,
      )
      continue
    }
    if (partSha256(part, where) !== entry.partSha256) {
      stale('partSha256', `does not match ${where} (${STALE})`)
      continue
    }
    bySlot.set(slot, entry.signature)
    kept.push(entry)
  }

  for (const [mi, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const first = message.parts.findIndex((part) => part.kind === 'tool-call')
    if (first === -1 || bySlot.has(`${mi}:${first}`)) continue
    const call = message.parts[first]
    throw badState(
      `messages.${mi}.parts.${first}`,
      `replays tool call "${call?.kind === 'tool-call' ? call.toolCallId : ''}" without its thought signature in transientProviderState; Gemini 3 rejects a function call that lost it. Send the transientProviderState from the result that produced this message, and the history unedited, with the same model string. If you removed messages from the history, remove their entries with dropMessagesFromSignatureState`,
    )
  }
  return { bySlot, kept, dropped }
}

/** Build the entry for a part the model signed (a text or tool-call part). */
export function signatureEntry(
  messageIndex: number,
  partIndex: number,
  model: string,
  part: Part,
  signature: string,
): GoogleSignatureEntry {
  if (part.kind !== 'text' && part.kind !== 'tool-call') {
    throw badState(
      `messages.${messageIndex}.parts.${partIndex}`,
      `a thought signature cannot be attached to a "${part.kind}" part`,
    )
  }
  return {
    messageIndex,
    partIndex,
    kind: part.kind,
    model,
    partSha256: partSha256(part),
    signature,
  }
}

/**
 * Remove the entries for messages the host removed from its history, and shift
 * the `messageIndex` of every later entry down so it still points at the same
 * message. `indices` are positions in the history the state was issued for
 * (before the removal). Whole turns only: remove a tool-call message together
 * with its tool-result message, and never keep a tool-call message while
 * removing its entry. Returns `undefined` when no entry remains, so the result
 * can be sent as `transientProviderState` or omitted.
 */
export function dropMessagesFromSignatureState(
  state: unknown,
  indices: readonly number[],
): GoogleSignatureState | undefined {
  const removed = new Set<number>()
  for (const [i, value] of indices.entries()) {
    if (!Number.isInteger(value) || value < 0) {
      throw new LlmError(
        `dropMessagesFromSignatureState: indices.${i} must be a non-negative integer.`,
        {
          kind: 'bad_request',
          retryable: false,
          issues: [{ path: `indices.${i}`, message: 'must be a non-negative integer' }],
        },
      )
    }
    if (removed.has(value)) {
      throw new LlmError(
        `dropMessagesFromSignatureState: indices.${i} repeats message ${value}.`,
        {
          kind: 'bad_request',
          retryable: false,
          issues: [{ path: `indices.${i}`, message: 'is a duplicate' }],
        },
      )
    }
    removed.add(value)
  }
  const sorted = [...removed].sort((a, b) => a - b)
  const signatures: GoogleSignatureEntry[] = []
  for (const entry of parseSignatureState(state)) {
    if (removed.has(entry.messageIndex)) continue
    const shift = sorted.filter((index) => index < entry.messageIndex).length
    signatures.push({ ...entry, messageIndex: entry.messageIndex - shift })
  }
  return signatures.length > 0 ? { google: { signatures } } : undefined
}
