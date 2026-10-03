/**
 * geminiContentToMessages — migration utility: `@google/genai` `Content[]` →
 * any-llm's normalized `Message[]`.
 *
 * For consumers moving hand-authored `@google/genai` prompts onto this
 * library. Uses `@google/genai` TYPES ONLY (no runtime SDK dependency — the
 * package is a peer dep, imported here with `import type`).
 *
 * Reject-don't-map: every genai `Content`/`Part` shape this utility cannot
 * losslessly represent in any-llm's normalized types throws a typed
 * `LlmError('bad_request')` naming the offending field or kind. Nothing is
 * ever silently dropped — that silent-loss failure mode is exactly what this
 * utility exists to eliminate for migrating callers.
 *
 * Validation is an exhaustive own-key scan: the set of defined keys on each
 * `Part` must be EXACTLY one of the recognized combinations (`['text']`,
 * `['inlineData']`, `['inlineData', 'mediaResolution']`, `['fileData']`,
 * `['fileData', 'mediaResolution']`), plus `functionCall` / `functionResponse`.
 * A `thoughtSignature` on a model text or `functionCall` part is imported into
 * `transientProviderState` (see {@link GeminiContentToMessagesInput.model});
 * on any other part it throws. Any other key — including unknown
 * future SDK fields — or any combination outside that set throws. Keys whose
 * value is `undefined` are treated as absent (genai types are all-optional;
 * only defined values count).
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { JsonValue, Message, Part } from '@gullabs/core'
import type { Content, Part as GenaiPart } from '@google/genai'
import { reserveProviderToolCallIds, resolveToolCallId } from './tool-call-id.js'
import { signatureEntry } from './thought-signatures.js'
import type { GoogleSignatureEntry } from './thought-signatures.js'

/**
 * Input accepted by {@link geminiContentToMessages}.
 */
export interface GeminiContentToMessagesInput {
  /** Raw `@google/genai` conversation history to convert. */
  contents: Content[]
  /**
   * Raw `@google/genai` system instruction — either the SDK's shorthand
   * plain string, or a full `Content` (only text parts supported; any
   * non-text part throws).
   */
  systemInstruction?: Content | string
  /**
   * The model string the converted history will be sent to. Required when any
   * part carries a `thoughtSignature`: signatures are bound to the model that
   * issued them and are never replayed on another one.
   */
  model?: string
}

/**
 * Output produced by {@link geminiContentToMessages}.
 */
export interface GeminiContentToMessagesResult {
  /** Concatenated system text, present only when `systemInstruction` was given. */
  system?: string
  /** Normalized any-llm messages, one per input `Content`. */
  messages: Message[]
  /**
   * The thought signatures found on model parts, as the overlay a Gemini 3.x
   * request takes as `transientProviderState`. Present only when at least one
   * part carried a `thoughtSignature`. Send it with `messages` unedited and the
   * same `model`.
   */
  transientProviderState?: JsonValue
}

function badRequest(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false })
}

/**
 * Own keys of `obj` whose value is defined. genai types are all-optional;
 * a key explicitly set to `undefined` is treated as absent.
 */
function definedKeys(obj: object): string[] {
  return Object.keys(obj).filter(
    (key) => (obj as Record<string, unknown>)[key] !== undefined,
  )
}

// ---------------------------------------------------------------------------
// mediaResolution mapping (Gemini PartMediaResolutionLevel → our normalized hint)
// ---------------------------------------------------------------------------

function mapMediaResolutionLevel(
  level: string,
  location: string,
): 'low' | 'medium' | 'high' {
  switch (level) {
    case 'MEDIA_RESOLUTION_LOW':
      return 'low'
    case 'MEDIA_RESOLUTION_MEDIUM':
      return 'medium'
    case 'MEDIA_RESOLUTION_HIGH':
      return 'high'
    default:
      throw badRequest(
        `${location}: unsupported Part.mediaResolution.level "${level}" — any-llm only ` +
          'supports MEDIA_RESOLUTION_LOW, MEDIA_RESOLUTION_MEDIUM, MEDIA_RESOLUTION_HIGH.',
      )
  }
}

/**
 * Convert a defined `Part.mediaResolution` object to the normalized hint.
 *
 * Exhaustive own-key scan: the only representable key is `level`, and it must
 * carry a usable value. An explicit-but-empty `mediaResolution` (empty object,
 * or `level: undefined`) is ambiguous — the caller wrote something any-llm
 * cannot interpret — so it throws rather than being silently ignored.
 */
function convertMediaResolution(
  mediaResolution: NonNullable<GenaiPart['mediaResolution']>,
  location: string,
): 'low' | 'medium' | 'high' {
  const extraKeys = definedKeys(mediaResolution).filter((key) => key !== 'level')
  if (extraKeys.length > 0) {
    throw badRequest(
      `${location}: Part.mediaResolution keys [${extraKeys.join(', ')}] are not ` +
        'representable in any-llm — only mediaResolution.level is supported.',
    )
  }

  if (mediaResolution.level === undefined) {
    throw badRequest(
      `${location}: Part.mediaResolution is present but carries no level — an ` +
        'explicit-but-empty mediaResolution is ambiguous; set level or omit the field.',
    )
  }

  return mapMediaResolutionLevel(mediaResolution.level, location)
}

// ---------------------------------------------------------------------------
// Part mapping (exhaustive own-key scan, reject-don't-map)
// ---------------------------------------------------------------------------

/**
 * Convert a single `@google/genai` `Part` to its any-llm equivalent.
 *
 * The defined-key set of the part must be exactly one of: `['text']`,
 * `['inlineData']`, `['inlineData', 'mediaResolution']`, `['fileData']`,
 * `['fileData', 'mediaResolution']` (or a lone `functionCall` / `functionResponse`).
 * Anything else — executable code, thought-flagged parts, `videoMetadata`,
 * `partMetadata`, unknown future SDK fields, `text` combined with any other
 * key, or a part with zero recognized fields — throws `LlmError('bad_request')`
 * naming the offending key(s). `thoughtSignature` is not a content key here: it
 * is read by {@link convertPartWithSignature}.
 */
function convertPart(
  part: GenaiPart,
  location: string,
  nameCounts: Map<string, number>,
  reservedIds: Set<string>,
): Part {
  const keys = definedKeys(part).filter((key) => key !== 'thoughtSignature')
  const baseKeys = keys.filter(
    (key) => key === 'text' || key === 'inlineData' || key === 'fileData',
  )

  if (baseKeys.length === 0) {
    if (keys.includes('functionCall') && keys.every((k) => k === 'functionCall')) {
      const fc = (
        part as { functionCall?: { id?: string; name?: string; args?: unknown } }
      ).functionCall
      if (fc === undefined || typeof fc.name !== 'string' || fc.name.length === 0) {
        throw badRequest(`${location}: functionCall.name is required.`)
      }
      return {
        kind: 'tool-call',
        toolCallId: resolveToolCallId(fc.id, fc.name, nameCounts, reservedIds),
        toolName: fc.name,
        args: (fc.args ?? {}) as JsonValue,
      }
    }
    if (
      keys.includes('functionResponse') &&
      keys.every((k) => k === 'functionResponse')
    ) {
      const fr = (
        part as { functionResponse?: { id?: string; name?: string; response?: unknown } }
      ).functionResponse
      if (fr === undefined || typeof fr.name !== 'string' || fr.name.length === 0) {
        throw badRequest(`${location}: functionResponse.name is required.`)
      }
      return {
        kind: 'tool-result',
        toolCallId: resolveToolCallId(
          fr.id,
          fr.name,
          nameCounts,
          reservedIds,
          `result:${fr.name}`,
        ),
        toolName: fr.name,
        result: (fr.response ?? null) as JsonValue,
      }
    }
    if (keys.length === 0) {
      throw badRequest(
        `${location}: Part has no recognized fields set (expected exactly one of ` +
          'text, inlineData, fileData).',
      )
    }
    throw badRequest(
      `${location}: Part keys [${keys.join(', ')}] are not supported by ` +
        'geminiContentToMessages — only text, inlineData, fileData, functionCall, ' +
        'and functionResponse parts can be represented in any-llm.',
    )
  }

  if (baseKeys.length > 1) {
    throw badRequest(
      `${location}: Part has more than one of text/inlineData/fileData set ` +
        `([${baseKeys.join(', ')}]) — geminiContentToMessages requires exactly one.`,
    )
  }

  const base = baseKeys[0] as 'text' | 'inlineData' | 'fileData'
  const extraKeys = keys.filter(
    (key) => key !== base && !(base !== 'text' && key === 'mediaResolution'),
  )
  if (extraKeys.length > 0) {
    throw badRequest(
      `${location}: Part keys [${extraKeys.join(', ')}] cannot be represented in ` +
        `any-llm alongside ${base} — nothing is silently dropped.`,
    )
  }

  if (part.text !== undefined) {
    return { kind: 'text', text: part.text }
  }

  if (part.inlineData !== undefined) {
    const inlineData = part.inlineData
    const inlineExtraKeys = definedKeys(inlineData).filter(
      (key) => key !== 'mimeType' && key !== 'data',
    )
    if (inlineExtraKeys.length > 0) {
      throw badRequest(
        `${location}: Part.inlineData keys [${inlineExtraKeys.join(', ')}] are not ` +
          'representable in any-llm.',
      )
    }
    if (inlineData.mimeType === undefined) {
      throw badRequest(`${location}: Part.inlineData.mimeType is required.`)
    }
    if (inlineData.data === undefined) {
      throw badRequest(`${location}: Part.inlineData.data is required.`)
    }
    return {
      kind: 'inline-media',
      mimeType: inlineData.mimeType,
      data: inlineData.data,
      ...(part.mediaResolution !== undefined
        ? { mediaResolution: convertMediaResolution(part.mediaResolution, location) }
        : {}),
    }
  }

  if (part.fileData !== undefined) {
    const fileData = part.fileData
    const fileExtraKeys = definedKeys(fileData).filter(
      (key) => key !== 'fileUri' && key !== 'mimeType',
    )
    if (fileExtraKeys.length > 0) {
      throw badRequest(
        `${location}: Part.fileData keys [${fileExtraKeys.join(', ')}] are not ` +
          'representable in any-llm.',
      )
    }
    if (fileData.fileUri === undefined) {
      throw badRequest(`${location}: Part.fileData.fileUri is required.`)
    }
    if (fileData.mimeType === undefined) {
      throw badRequest(`${location}: Part.fileData.mimeType is required.`)
    }
    return {
      kind: 'file-uri',
      uri: fileData.fileUri,
      mimeType: fileData.mimeType,
      ...(part.mediaResolution !== undefined
        ? { mediaResolution: convertMediaResolution(part.mediaResolution, location) }
        : {}),
    }
  }

  // Unreachable: baseKeys.length === 1 guarantees one of the branches above.
  throw badRequest(`${location}: Part has no recognized fields set.`)
}

/**
 * {@link convertPart} plus the part's `thoughtSignature`, which is importable
 * only from a model text or `functionCall` part: those are the parts Gemini 3.x
 * signs and a message can represent.
 */
function convertPartWithSignature(
  part: GenaiPart,
  location: string,
  role: 'user' | 'assistant',
  nameCounts: Map<string, number>,
  reservedIds: Set<string>,
): { part: Part; signature?: string } {
  const converted = convertPart(part, location, nameCounts, reservedIds)
  const signature = part.thoughtSignature
  if (signature === undefined) return { part: converted }
  if (typeof signature !== 'string' || signature.length === 0) {
    throw badRequest(`${location}: Part.thoughtSignature must be a non-empty string.`)
  }
  if (
    role !== 'assistant' ||
    (converted.kind !== 'text' && converted.kind !== 'tool-call')
  ) {
    throw badRequest(
      `${location}: Part.thoughtSignature can only be imported from a model text or functionCall part.`,
    )
  }
  return { part: converted, signature }
}

// ---------------------------------------------------------------------------
// Role mapping (no inference)
// ---------------------------------------------------------------------------

function convertRole(role: string | undefined, location: string): 'user' | 'assistant' {
  if (role === 'user') return 'user'
  if (role === 'model') return 'assistant'
  throw badRequest(
    `${location}: Content.role "${String(role)}" is not supported — only "user" and ` +
      '"model" are recognized. any-llm never infers a missing role.',
  )
}

// ---------------------------------------------------------------------------
// systemInstruction mapping (NEVER inferred from contents)
// ---------------------------------------------------------------------------

/**
 * Concatenate the text parts of a `systemInstruction`.
 *
 * A string is used as-is. For a `Content`, the envelope's defined-key set
 * must be exactly `['parts']` (or empty) — `role`, or any unknown future
 * Content field, throws naming the key(s). Every part's defined-key set must
 * be exactly `['text']` — any other key (media, tool shapes, thought flags,
 * `mediaResolution`, unknown future fields) throws naming the offending
 * key(s). A `Content` with zero parts yields `''` (the caller explicitly
 * supplied a system instruction; the derivation is just empty).
 */
function convertSystemInstruction(systemInstruction: Content | string): string {
  if (typeof systemInstruction === 'string') {
    return systemInstruction
  }

  const envelopeExtraKeys = definedKeys(systemInstruction).filter(
    (key) => key !== 'parts',
  )
  if (envelopeExtraKeys.length > 0) {
    throw badRequest(
      `systemInstruction: Content keys [${envelopeExtraKeys.join(', ')}] are not ` +
        'supported on a system instruction — only parts is allowed.',
    )
  }

  const parts = systemInstruction.parts ?? []
  const textFragments: string[] = []

  parts.forEach((part, index) => {
    const keys = definedKeys(part)
    if (keys.length !== 1 || keys[0] !== 'text' || part.text === undefined) {
      const offending = keys.filter((key) => key !== 'text')
      const named = offending.length > 0 ? offending : keys
      throw badRequest(
        `systemInstruction.parts[${index}]: only text parts are allowed in a system ` +
          `instruction — part keys [${named.length > 0 ? named.join(', ') : 'none'}] ` +
          'are not supported.',
      )
    }
    textFragments.push(part.text)
  })

  return textFragments.join('')
}

// ---------------------------------------------------------------------------
// geminiContentToMessages
// ---------------------------------------------------------------------------

/**
 * Convert `@google/genai` `Content[]` / `Part[]` into any-llm's normalized
 * `{ system?, messages }` shape.
 *
 * A migration utility for callers moving hand-authored `@google/genai`
 * prompts onto any-llm. Exhaustive and reject-don't-map: any genai shape
 * that cannot be losslessly represented in any-llm's normalized types
 * throws `LlmError('bad_request')` naming the offending kind/field instead
 * of silently dropping it.
 *
 * `system` is derived ONLY from the explicit `systemInstruction` input —
 * never inferred from `contents`.
 *
 * @example
 * ```ts
 * // Before: hand-rolled @google/genai prompt
 * const contents: Content[] = [
 *   { role: 'user', parts: [{ text: 'Describe this image.' }, { inlineData: { mimeType: 'image/png', data } }] },
 *   { role: 'model', parts: [{ text: 'A red bicycle leaning against a brick wall.' }] },
 * ]
 *
 * // After: migrate onto any-llm's normalized shape in one call
 * import { geminiContentToMessages } from '@gullabs/google'
 *
 * const { system, messages } = geminiContentToMessages({
 *   contents,
 *   systemInstruction: 'You are a concise visual describer.',
 * })
 *
 * const result = await client.generate({ provider: 'google', model: 'gemini-2.5-pro', system, messages }, { auth })
 * ```
 */
export function geminiContentToMessages(
  input: GeminiContentToMessagesInput,
): GeminiContentToMessagesResult {
  const system =
    input.systemInstruction !== undefined
      ? convertSystemInstruction(input.systemInstruction)
      : undefined

  const nameCounts = new Map<string, number>()
  const reservedIds = reserveProviderToolCallIds(
    input.contents.flatMap((content) =>
      (content.parts ?? []).flatMap((part) => {
        const p = part as {
          functionCall?: { id?: string }
          functionResponse?: { id?: string }
        }
        return [p.functionCall?.id, p.functionResponse?.id]
      }),
    ),
  )
  const signatures: GoogleSignatureEntry[] = []
  const messages: Message[] = input.contents.map((content, contentIndex) => {
    const location = `contents[${contentIndex}]`
    const envelopeExtraKeys = definedKeys(content).filter(
      (key) => key !== 'role' && key !== 'parts',
    )
    if (envelopeExtraKeys.length > 0) {
      throw badRequest(
        `${location}: Content keys [${envelopeExtraKeys.join(', ')}] are not ` +
          'supported — only role and parts are allowed.',
      )
    }
    const role = convertRole(content.role, location)
    const parts = (content.parts ?? []).map((part, partIndex) => {
      const partLocation = `${location}.parts[${partIndex}]`
      const converted = convertPartWithSignature(
        part,
        partLocation,
        role,
        nameCounts,
        reservedIds,
      )
      if (converted.signature !== undefined) {
        if (input.model === undefined) {
          throw badRequest(
            `${partLocation}: Part.thoughtSignature requires the \`model\` input; a signature is bound to the model that issued it.`,
          )
        }
        signatures.push(
          signatureEntry(
            contentIndex,
            partIndex,
            input.model,
            converted.part,
            converted.signature,
          ),
        )
      }
      return converted.part
    })
    return { role, parts }
  })

  return {
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(signatures.length > 0
      ? { transientProviderState: { google: { signatures } } as unknown as JsonValue }
      : {}),
  }
}
