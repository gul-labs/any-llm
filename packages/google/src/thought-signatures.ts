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
 * { google: { signatures: [{ messageIndex, partIndex, model, partSha256, signature }] } }
 * ```
 *
 * `messageIndex` indexes `request.messages`, `partIndex` indexes that message's
 * `parts` (thought parts are never in a message), `model` is the model string
 * the request named, and `partSha256` is the SHA-256 of the part's RFC 8785
 * canonical JSON, so an edited argument or text is detected and key order
 * (Postgres `jsonb`) does not matter.
 *
 * @module
 */

import { createHash } from 'node:crypto'

import { LlmError, canonicalJson } from '@gullabs/core'
import type { JsonValue, Message, Part } from '@gullabs/core'

/** One signature, pinned to a part of the host's history. */
export interface GoogleSignatureEntry {
  messageIndex: number
  partIndex: number
  model: string
  partSha256: string
  signature: string
}

/** The shape of `transientProviderState` for Gemini 3.x models. */
export interface GoogleSignatureState {
  google: { signatures: GoogleSignatureEntry[] }
}

const STATE_PATH = 'transientProviderState'
const SHA256_HEX = /^[0-9a-f]{64}$/
const ENTRY_KEYS = new Set([
  'messageIndex',
  'partIndex',
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
    const { messageIndex, partIndex, model, partSha256: digest, signature } = raw
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
    if (typeof model !== 'string' || model.length === 0) {
      throw badState(`${path}.model`, 'must be a non-empty string')
    }
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      throw badState(`${path}.partSha256`, 'must be 64 lowercase hex characters')
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw badState(`${path}.signature`, 'must be a non-empty string')
    }
    return { messageIndex, partIndex, model, partSha256: digest, signature }
  })
}

const STALE =
  'history was edited, reordered or produced by another model after the signature was issued'

/**
 * Check the overlay against the host's messages and return the signature for
 * each `"messageIndex:partIndex"`. Every entry must name an assistant message
 * and a part whose hash matches, issued for the model this request names;
 * anything else (mismatch, out of range, duplicate, other model) is
 * `bad_request`. Then every assistant message that replays tool calls must have
 * an entry for its first tool-call part: Google signs only the first function
 * call of a model turn, and rejects the turn without it.
 */
export function resolveSignatures(
  entries: readonly GoogleSignatureEntry[],
  messages: readonly Message[],
  model: string,
): Map<string, string> {
  const bySlot = new Map<string, string>()
  for (const [index, entry] of entries.entries()) {
    const path = `${STATE_PATH}.google.signatures.${index}`
    const slot = `${entry.messageIndex}:${entry.partIndex}`
    if (entry.model !== model) {
      throw badState(
        `${path}.model`,
        `was issued for model "${entry.model}" but this request names "${model}"; signatures are not replayed across models (${STALE})`,
      )
    }
    const message = messages[entry.messageIndex]
    if (message === undefined || message.role !== 'assistant') {
      throw badState(
        `${path}.messageIndex`,
        `does not point at an assistant message in messages (${STALE})`,
      )
    }
    const part = message.parts[entry.partIndex]
    if (part === undefined) {
      throw badState(`${path}.partIndex`, `is out of range for the message (${STALE})`)
    }
    if (bySlot.has(slot)) {
      throw badState(
        path,
        `duplicates the entry for messages.${entry.messageIndex}.parts.${entry.partIndex}`,
      )
    }
    if (
      partSha256(part, `messages.${entry.messageIndex}.parts.${entry.partIndex}`) !==
      entry.partSha256
    ) {
      throw badState(
        `${path}.partSha256`,
        `does not match messages.${entry.messageIndex}.parts.${entry.partIndex} (${STALE})`,
      )
    }
    bySlot.set(slot, entry.signature)
  }

  for (const [mi, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    const first = message.parts.findIndex((part) => part.kind === 'tool-call')
    if (first === -1 || bySlot.has(`${mi}:${first}`)) continue
    const call = message.parts[first]
    throw badState(
      `messages.${mi}.parts.${first}`,
      `replays tool call "${call?.kind === 'tool-call' ? call.toolCallId : ''}" without its thought signature in transientProviderState; Gemini 3 rejects a function call that lost it. Send the transientProviderState from the result that produced this message, and the history unedited, with the same model string`,
    )
  }
  return bySlot
}

/** Build the entry for a part the model signed. */
export function signatureEntry(
  messageIndex: number,
  partIndex: number,
  model: string,
  part: Part,
  signature: string,
): GoogleSignatureEntry {
  return {
    messageIndex,
    partIndex,
    model,
    partSha256: partSha256(part),
    signature,
  }
}
