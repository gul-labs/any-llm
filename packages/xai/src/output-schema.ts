/**
 * output-schema.ts — local preflight for xAI strict structured output.
 *
 * The adapter sends `outputJsonSchema` as `text.format` with `strict: true`.
 * xAI reads it as standard JSON Schema. Two host mistakes come from schemas
 * written in the OpenAPI / Gemini dialect (live-probed 2026-10-02, grok-4.5):
 *
 * 1. `nullable: true` is not a JSON Schema keyword. xAI accepts the request
 *    and ignores the keyword, so the field is required and non-null. The
 *    model then cannot say "unknown" and writes `""`, `0` or the string
 *    `"null"`. Nothing fails; the data is wrong.
 * 2. Uppercase type names (`STRING`, `OBJECT`) fail xAI's schema validation
 *    with HTTP 400 after a network round trip.
 *
 * Both are rejected here with the offending path. The schema is never
 * rewritten: a nullable field lists `'null'` in `type`
 * (`type: ['string', 'null']`).
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'

const JSON_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
])

/** Keywords whose value is one subschema. */
const SINGLE_SCHEMA_KEYWORDS = [
  'additionalProperties',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
] as const

/** Keywords whose value is an array of subschemas (`items` tuple form included). */
const SCHEMA_ARRAY_KEYWORDS = ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf'] as const

/** Keywords whose value maps arbitrary names to subschemas. */
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
] as const

function isPlainObject(
  value: JsonValue | undefined,
): value is { [k: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function badSchema(message: string): LlmError {
  return new LlmError(message, { kind: 'bad_request', retryable: false, provider: 'xai' })
}

function assertNode(node: { [k: string]: JsonValue }, path: string): void {
  const at = path.length > 0 ? path : '<root>'

  if ('nullable' in node) {
    throw badSchema(
      `xAI structured output takes standard JSON Schema, which has no \`nullable\` keyword (found at \`${at}\`). xAI ignores it, so the field would be required and non-null. List 'null' in \`type\` instead, e.g. type: ['string', 'null'].`,
    )
  }

  const type = node['type']
  if (type !== undefined) {
    const names = Array.isArray(type) ? type : [type]
    for (const name of names) {
      if (typeof name !== 'string' || !JSON_SCHEMA_TYPES.has(name)) {
        throw badSchema(
          `xAI structured output takes standard JSON Schema; \`type\` ${JSON.stringify(
            name,
          )} at \`${at}\` is not a JSON Schema type. Use lowercase string, number, integer, boolean, object, array or null.`,
        )
      }
    }
  }

  const child = (segment: string): string =>
    path.length > 0 ? `${path}.${segment}` : segment

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = node[keyword]
    if (!isPlainObject(map)) continue
    for (const [key, member] of Object.entries(map)) {
      if (isPlainObject(member)) assertNode(member, child(`${keyword}.${key}`))
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const members = node[keyword]
    if (!Array.isArray(members)) continue
    members.forEach((member, index) => {
      if (isPlainObject(member)) assertNode(member, child(`${keyword}[${index}]`))
    })
  }
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const member = node[keyword]
    if (isPlainObject(member)) assertNode(member, child(keyword))
  }
}

/**
 * Reject an output schema written in the OpenAPI / Gemini dialect.
 *
 * Only schema positions are inspected, so a property that is itself named
 * `nullable` or `type` is fine. Never mutates `schema`.
 *
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's path.
 */
export function assertXaiOutputJsonSchema(schema: JsonValue): void {
  if (isPlainObject(schema)) assertNode(schema, '')
}
