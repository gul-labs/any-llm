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
 * - The rule for "ignored": a keyword is outside a model family's set when P3
 *   saw it violated in at least 6 of 7 samples on every model of that family.
 *   A keyword that was violated less often is supported but soft (obeyed
 *   probabilistically; the worst Gemini cell was 4 of 7) and stays in the set:
 *   `pattern`, `minLength` and `maxLength`. Hosts must still validate `output`.
 * - Gemma 4 violated `format` on 7 of 7 samples on both models and
 *   `minLength`/`maxLength` on 7 of 7 and 6 of 7, so those three are outside
 *   the Gemma set (`pattern` was violated on 0 of 7 and 4 of 7: soft, kept).
 * - `format` values: P3 exercised `date-time`, `date` and `email`. `time` is
 *   named in Google's guide but no capture exercised it, so it is not enforced
 *   here; it is rejected until a capture shows it.
 * - `pattern` is held to the regex subset (`patternSubset`): P3 probed one
 *   simple pattern (`^[A-Z]{3}-[0-9]{4}$`) and nothing shows lookaround, `\b`,
 *   backreferences or property escapes are accepted and enforced.
 * - Tool schemas (`parametersJsonSchema`) use the same profile. Live evidence
 *   for tools beyond trivial schemas rests on the output-schema probe (P3 ran
 *   `responseJsonSchema` only); see the package README.
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

/** Enforced `format` values: the ones P3 exercised and saw enforced. */
const GOOGLE_FORMATS = ['date-time', 'date', 'email'] as const

const GEMINI_PROFILE: JsonSchemaProfile = {
  provider: 'google',
  keywords: GEMINI_KEYWORDS,
  formats: GOOGLE_FORMATS,
  limits: {},
  circularRefs: true,
  booleanItems: true,
  patternSubset: true,
}

const GEMMA_PROFILE: JsonSchemaProfile = {
  ...GEMINI_PROFILE,
  keywords: GEMINI_KEYWORDS.filter((keyword) => !GEMMA_IGNORED_KEYWORDS.has(keyword)),
}

/**
 * The keyword profile the adapter enforces for a model.
 *
 * @param canonicalModel The resolved descriptor's canonical `model`, never the
 *   request string (which may be a declared alias).
 */
export function googleJsonSchemaProfile(canonicalModel: string): JsonSchemaProfile {
  return canonicalModel.startsWith('gemma-') ? GEMMA_PROFILE : GEMINI_PROFILE
}
