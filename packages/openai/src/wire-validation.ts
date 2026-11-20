/**
 * wire-validation.ts — exact validators for the wire shapes this release
 * admits (ADR-047): image URLs, base64 payloads, and every item of a replayed
 * `transientProviderState`.
 *
 * Replay state is forwarded to OpenAI verbatim, so a key it carries is a key the
 * request sends. Every replayed item and every nested part is therefore checked
 * against an exact allowlist of keys and value types; an unknown key anywhere is
 * `bad_request` naming its path. The allowlists are:
 *
 * - The request items this adapter itself builds (`client.ts`): a user or
 *   developer `message` (`type`, `role`, `content`) of `input_text` (`type`,
 *   `text`) and `input_image` (`type`, `image_url`, `detail: 'auto'`) parts; an
 *   assistant history `message` (`type`, `role`, `content` as a string); a
 *   `function_call_output` (`type`, `call_id`, `output` as a string).
 * - The provider output items the adapter reads, with the keys the `openai`
 *   7.60.0 typings define (`src/resources/responses/responses.ts`, read
 *   2026-11-20):
 *   - `ResponseOutputMessage`: `id`, `content`, `role: 'assistant'`, `status`,
 *     `type: 'message'`, `phase?`; content parts `ResponseOutputText` (`type`,
 *     `text`, `annotations`, `logprobs?`) and `ResponseOutputRefusal` (`type`,
 *     `refusal`).
 *   - `ResponseReasoningItem`: `id`, `summary` (`{ type: 'summary_text', text }`),
 *     `type: 'reasoning'`, `content?` (`{ type: 'reasoning_text', text }`),
 *     `encrypted_content?` (string or null), `status?`.
 *   - `ResponseFunctionToolCall`: `arguments`, `call_id`, `name`,
 *     `type: 'function_call'`, `id?`, `status?`, `caller?`, plus `async?` and
 *     `namespace?`.
 *
 * Values that only a deferred feature produces are rejected even where the
 * typings name the key, because the state may carry only what this release can
 * produce: `annotations` must be empty (citations and file paths come from
 * built-in tools), `logprobs` absent or empty (logprobs are never requested), a
 * function call's `caller` only `{ type: 'direct' }` (a `program` caller is
 * programmatic tool calling), and `async` and `namespace` are not admitted
 * (async function tools and tool namespaces are never declared).
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

import { OPENAI_INPUT_MIME_TYPES } from './model-limits.js'

function bad(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'openai',
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Image URLs and base64
// ---------------------------------------------------------------------------

/**
 * A fully qualified `http(s)` URL, checked on the string that is sent: the
 * scheme, `://`, a non-empty authority, then an optional path, query or
 * fragment, with no whitespace, control character or backslash anywhere (the
 * WHATWG parser rewrites `\` to `/` and accepts `https:host` without `//`, so a
 * parse alone would validate a string other than the one forwarded). The string
 * must also parse to the same scheme with a non-empty host.
 */
export function isFullyQualifiedHttpUrl(value: string): boolean {
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return false
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#].*)?$/i.exec(value)
  if (match === null) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === `${(match[1] as string).toLowerCase()}:` && url.hostname !== ''
    )
  } catch {
    return false
  }
}

/** The base64 alphabet, then at most two `=` at the very end. Linear time. */
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * True for a non-empty, padded, standard-alphabet base64 string (RFC 4648 §4):
 * the alphabet with `=` only as the last one or two characters, and a length
 * that is a multiple of four. Checked without decoding.
 */
export function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_SHAPE.test(value)
}

/**
 * The media type of a `data:<type>;base64,<payload>` image URL whose type is
 * admitted and whose payload is valid base64, else `undefined`.
 */
export function admittedImageDataUrl(value: string): string | undefined {
  const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,/i.exec(value)
  if (match === null) return undefined
  const media = (match[1] as string).toLowerCase()
  if (!OPENAI_INPUT_MIME_TYPES.includes(media)) return undefined
  return isBase64(value.slice(match[0].length)) ? media : undefined
}

// ---------------------------------------------------------------------------
// Exact-key checks
// ---------------------------------------------------------------------------

type Check = (value: unknown, path: string) => void

interface Field {
  required: boolean
  check: Check
}

const req = (check: Check): Field => ({ required: true, check })
const opt = (check: Check): Field => ({ required: false, check })

function exact(value: unknown, path: string, fields: Record<string, Field>): void {
  if (!isPlainRecord(value)) throw bad(`${path} must be an object.`)
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      throw bad(
        `${path}.${key} is not a field @gullabs/openai admits in replay state (allowed: ${Object.keys(
          fields,
        ).join(', ')}).`,
      )
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(value, key)) {
      if (field.required) throw bad(`${path}.${key} is required in replay state.`)
      continue
    }
    field.check(value[key], `${path}.${key}`)
  }
}

const literal =
  (...allowed: unknown[]): Check =>
  (value, path) => {
    if (!allowed.includes(value)) {
      throw bad(`${path} must be ${allowed.map((a) => JSON.stringify(a)).join(' or ')}.`)
    }
  }

const string: Check = (value, path) => {
  if (typeof value !== 'string') throw bad(`${path} must be a string.`)
}

const nonEmptyString: Check = (value, path) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw bad(`${path} must be a non-empty string.`)
  }
}

const stringOrNull: Check = (value, path) => {
  if (value !== null && typeof value !== 'string') {
    throw bad(`${path} must be a string or null.`)
  }
}

const arrayOf =
  (check: Check): Check =>
  (value, path) => {
    if (!Array.isArray(value)) throw bad(`${path} must be an array.`)
    value.forEach((entry, i) => {
      check(entry, `${path}[${i}]`)
    })
  }

const emptyArray =
  (why: string): Check =>
  (value, path) => {
    if (!Array.isArray(value) || value.length > 0) {
      throw bad(`${path} must be an empty array in replay state (${why}).`)
    }
  }

const ITEM_STATUS = literal('in_progress', 'completed', 'incomplete')

// ---- input parts (the adapter's own request shapes) ------------------------

const imageUrl: Check = (value, path) => {
  if (typeof value !== 'string') throw bad(`${path} must be a string.`)
  const ok = value.startsWith('data:')
    ? admittedImageDataUrl(value) !== undefined
    : isFullyQualifiedHttpUrl(value)
  if (!ok) {
    throw bad(
      `${path} must be a fully qualified http(s) URL or a base64 data URL of ${OPENAI_INPUT_MIME_TYPES.join(
        ', ',
      )}.`,
    )
  }
}

const inputPart: Check = (value, path) => {
  const type = isPlainRecord(value) ? value['type'] : undefined
  if (type === 'input_text') {
    exact(value, path, { type: req(literal('input_text')), text: req(string) })
  } else if (type === 'input_image') {
    exact(value, path, {
      type: req(literal('input_image')),
      image_url: req(imageUrl),
      detail: req(literal('auto')),
    })
  } else {
    throw bad(
      `${path}.type ${JSON.stringify(type)} is not an input part @gullabs/openai sends (input_text, input_image).`,
    )
  }
}

// ---- output parts (SDK typings) --------------------------------------------

const outputPart: Check = (value, path) => {
  const type = isPlainRecord(value) ? value['type'] : undefined
  if (type === 'output_text') {
    exact(value, path, {
      type: req(literal('output_text')),
      text: req(string),
      annotations: req(emptyArray('annotations come from built-in tools')),
      logprobs: opt(emptyArray('logprobs are never requested')),
    })
  } else if (type === 'refusal') {
    exact(value, path, { type: req(literal('refusal')), refusal: req(string) })
  } else {
    throw bad(
      `${path}.type ${JSON.stringify(type)} is not an output part @gullabs/openai admits (output_text, refusal).`,
    )
  }
}

const reasoningText =
  (kind: 'summary_text' | 'reasoning_text'): Check =>
  (value, path) => {
    exact(value, path, { type: req(literal(kind)), text: req(string) })
  }

// ---- items -----------------------------------------------------------------

function assertMessage(item: Record<string, unknown>, path: string): void {
  const role = item['role']
  if (role === 'user' || role === 'developer') {
    exact(item, path, {
      type: req(literal('message')),
      role: req(literal(role)),
      content: req(arrayOf(inputPart)),
    })
    return
  }
  if (role === 'assistant' && typeof item['content'] === 'string') {
    // Assistant history the adapter built from a host message.
    exact(item, path, {
      type: req(literal('message')),
      role: req(literal('assistant')),
      content: req(string),
    })
    return
  }
  if (role === 'assistant') {
    // A provider `ResponseOutputMessage`.
    exact(item, path, {
      type: req(literal('message')),
      id: req(nonEmptyString),
      role: req(literal('assistant')),
      status: req(ITEM_STATUS),
      content: req(arrayOf(outputPart)),
      phase: opt(literal('commentary', 'final_answer', null)),
    })
    return
  }
  throw bad(`${path}.role ${JSON.stringify(role)} is not admitted in replay state.`)
}

/**
 * Check one replayed item against the exact shapes this release admits.
 *
 * @throws {LlmError} `bad_request` naming the offending path.
 */
export function assertReplayItem(item: unknown, path: string): void {
  if (!isPlainRecord(item)) throw bad(`${path} must be an object.`)
  switch (item['type']) {
    case 'message':
      assertMessage(item, path)
      return
    case 'reasoning':
      exact(item, path, {
        type: req(literal('reasoning')),
        id: req(nonEmptyString),
        summary: req(arrayOf(reasoningText('summary_text'))),
        content: opt(arrayOf(reasoningText('reasoning_text'))),
        encrypted_content: opt(stringOrNull),
        status: opt(ITEM_STATUS),
      })
      return
    case 'function_call':
      exact(item, path, {
        type: req(literal('function_call')),
        arguments: req(string),
        call_id: req(nonEmptyString),
        name: req(nonEmptyString),
        id: opt(nonEmptyString),
        status: opt(ITEM_STATUS),
        caller: opt((value, p) => {
          exact(value, p, { type: req(literal('direct')) })
        }),
      })
      return
    case 'function_call_output':
      exact(item, path, {
        type: req(literal('function_call_output')),
        call_id: req(nonEmptyString),
        output: req(string),
      })
      return
    default:
      throw bad(
        `${path}.type ${JSON.stringify(item['type'])} is not an item @gullabs/openai admits in replay state (message, reasoning, function_call, function_call_output).`,
      )
  }
}
