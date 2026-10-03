/**
 * json-schema.ts — the JSON Schema keywords Google enforces (ADR-034).
 *
 * The adapter sends `output.jsonSchema` as `responseJsonSchema` and a tool's
 * `inputJsonSchema` as `parametersJsonSchema`, verbatim and in the host's key
 * order. Google accepts every keyword and silently ignores the ones it does
 * not support, so the adapter declares the keywords that are enforced and
 * rejects everything else (`bad_request`, with the path) before dispatch.
 *
 * Sources:
 * - Google's structured-output guide, read 2026-10-03
 *   (https://ai.google.dev/gemini-api/docs/structured-output): types incl.
 *   `["T", "null"]`, `properties`, `required`, `additionalProperties` (boolean
 *   or schema), `enum`, `format`, `minimum`/`maximum`, `items`, `prefixItems`,
 *   `minItems`/`maxItems`. Its API reference treats `oneOf` as `anyOf`.
 * - Live probe P3, 2026-10-03, every available Gemini and Gemma model
 *   (`__fixtures__/response-json-schema-2026-10-03.json`). Enforced and kept in
 *   the set: `anyOf`, `$ref` / `$defs` (recursive too), `items: false`.
 *   Ignored on every model and therefore rejected: `const`, `allOf`,
 *   `exclusiveMinimum`, `multipleOf`, `uniqueItems`; `oneOf` with overlapping
 *   branches returned a value a true `oneOf` forbids (read as `anyOf`).
 * - `pattern`, `minLength` and `maxLength` are accepted by Google and obeyed
 *   only probabilistically (P3: violations on some Gemini models). They stay in
 *   the set because Google supports them; hosts must still validate.
 * - Gemma 4 ignored `format` on 7/7 calls and `minLength`/`maxLength` on 13 of
 *   14, so those three are outside the Gemma set.
 *
 * @module
 */

import type { JsonSchemaProfile } from '@gullabs/core'

const GEMINI_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'anyOf',
  '$ref',
  '$defs',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'format',
  'pattern',
  'minLength',
  'maxLength',
] as const

/** Keywords Gemma 4 ignored in P3, so the adapter does not accept them there. */
const GEMMA_IGNORED_KEYWORDS: ReadonlySet<string> = new Set([
  'format',
  'minLength',
  'maxLength',
])

/** Enforced `format` values: the documented ones plus `email`, which P3 verified. */
const GOOGLE_FORMATS = ['date-time', 'date', 'time', 'email'] as const

const GEMINI_PROFILE: JsonSchemaProfile = {
  provider: 'google',
  keywords: GEMINI_KEYWORDS,
  formats: GOOGLE_FORMATS,
  limits: {},
  circularRefs: true,
  booleanItems: true,
  patternSubset: false,
}

const GEMMA_PROFILE: JsonSchemaProfile = {
  ...GEMINI_PROFILE,
  keywords: GEMINI_KEYWORDS.filter((keyword) => !GEMMA_IGNORED_KEYWORDS.has(keyword)),
}

/** The keyword profile the adapter enforces for `model`. */
export function googleJsonSchemaProfile(model: string): JsonSchemaProfile {
  return model.startsWith('gemma-') ? GEMMA_PROFILE : GEMINI_PROFILE
}
