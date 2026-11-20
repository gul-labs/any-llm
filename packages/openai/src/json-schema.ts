/**
 * json-schema.ts — the JSON Schema OpenAI's strict Structured Outputs accept
 * (ADR-034, ADR-047).
 *
 * The adapter sends `output.jsonSchema` as `text.format` with `strict: true` and
 * a tool's `inputJsonSchema` as the function `parameters` with `strict: true`;
 * both go through {@link assertOpenAiStrictSchema} before dispatch, which runs
 * core's `assertJsonSchemaProfile` once (it runs `assertStandardJsonSchema`
 * itself) and then the strict-mode structural rules below. Nothing is rewritten:
 * a schema outside the rules is `bad_request` naming the path.
 *
 * Source: OpenAI's Structured Outputs guide, read 2026-11-20
 * (https://developers.openai.com/api/docs/guides/structured-outputs).
 * Documented, not live-verified:
 * - Supported: `type`, `properties`, `required`, `additionalProperties`, `enum`,
 *   `anyOf` (not at the root), `$ref` / `$defs` (recursion supported), `items`;
 *   string `pattern` and `format` (`date-time`, `time`, `date`, `duration`,
 *   `email`, `hostname`, `ipv4`, `ipv6`, `uuid`); number `multipleOf`,
 *   `maximum`, `exclusiveMaximum`, `minimum`, `exclusiveMinimum`; array
 *   `minItems`, `maxItems`.
 * - Unsupported: `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if`,
 *   `then`, `else`. Rejected (they are outside the keyword list).
 * - Not named by the guide, so rejected: `const`, `oneOf`, `prefixItems`,
 *   `minLength`, `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`,
 *   `patternProperties`, a constraining `propertyNames`.
 * - Strict-mode structure: the root is an object and not `anyOf`; every object
 *   lists all of its properties in `required` and sets
 *   `additionalProperties: false`; at most 5,000 object properties and 10 levels
 *   of nesting; at most 120,000 characters across property names, definition
 *   names and enum values; at most 1,000 enum values.
 * - `items: false` is undocumented and rejected; `pattern` is held to core's
 *   regex subset because the guide does not name the regex dialect.
 *
 * @module
 */

import { LlmError, assertJsonSchemaProfile } from '@gullabs/core'
import type { JsonSchemaProfile, JsonValue } from '@gullabs/core'

export const OPENAI_JSON_SCHEMA_PROFILE: JsonSchemaProfile = {
  provider: 'openai',
  keywords: [
    'type',
    'properties',
    'required',
    'additionalProperties',
    'enum',
    'anyOf',
    '$ref',
    '$defs',
    'items',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'pattern',
    'format',
  ],
  formats: [
    'date-time',
    'time',
    'date',
    'duration',
    'email',
    'hostname',
    'ipv4',
    'ipv6',
    'uuid',
  ],
  limits: {},
  circularRefs: true,
  booleanItems: false,
  patternSubset: true,
}

/** Strict-mode limits from the Structured Outputs guide (read 2026-11-20). */
export const OPENAI_STRICT_SCHEMA_LIMITS = Object.freeze({
  maxObjectProperties: 5_000,
  maxNestingDepth: 10,
  maxSchemaStringChars: 120_000,
  maxEnumValues: 1_000,
})

type JsonObject = { [key: string]: JsonValue }

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bad(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'openai',
  })
}

function namePath(path: string, name: string): string {
  return /^[^.[\]"\\]+$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`
}

function isObjectSchema(node: JsonObject): boolean {
  const type = node['type']
  if (type === 'object') return true
  if (Array.isArray(type)) return type.includes('object')
  return type === undefined && isObject(node['properties'])
}

interface Tally {
  properties: number
  chars: number
  enumValues: number
}

/**
 * Walks every schema position the profile admits (`properties`, `items`,
 * `anyOf`, `$defs`). `depth` counts the literal nesting of objects and arrays
 * in the document: the root is level 1, and each step into a property value or
 * an `items` schema adds one. Nesting reached through `$ref` is not counted
 * (OpenAI documents recursion as supported, so a reference has no fixed depth).
 */
function walkStrict(node: JsonValue, path: string, depth: number, tally: Tally): void {
  if (!isObject(node)) return
  if (depth > OPENAI_STRICT_SCHEMA_LIMITS.maxNestingDepth) {
    throw bad(
      `${path}: OpenAI strict schemas allow at most ${OPENAI_STRICT_SCHEMA_LIMITS.maxNestingDepth} levels of nesting.`,
    )
  }
  const enumValues = node['enum']
  if (Array.isArray(enumValues)) {
    tally.enumValues += enumValues.length
    for (const value of enumValues) {
      if (typeof value === 'string') tally.chars += value.length
    }
  }
  if (isObjectSchema(node)) {
    if (node['additionalProperties'] !== false) {
      throw bad(
        `${path}: every object in an OpenAI strict schema must set additionalProperties: false.`,
      )
    }
    const properties = isObject(node['properties']) ? node['properties'] : {}
    const names = Object.keys(properties)
    const required = Array.isArray(node['required']) ? node['required'] : []
    const missing = names.filter((name) => !required.includes(name))
    if (missing.length > 0) {
      throw bad(
        `${path}.required: an OpenAI strict schema lists every property as required; missing [${missing
          .map((name) => JSON.stringify(name))
          .join(', ')}]. Model an optional field as a union with null.`,
      )
    }
    tally.properties += names.length
    for (const name of names) {
      tally.chars += name.length
      walkStrict(
        properties[name] ?? null,
        namePath(`${path}.properties`, name),
        depth + 1,
        tally,
      )
    }
  }
  if (isObject(node['items'])) {
    walkStrict(node['items'], `${path}.items`, depth + 1, tally)
  }
  const anyOf = node['anyOf']
  if (Array.isArray(anyOf)) {
    anyOf.forEach((branch, index) => {
      walkStrict(branch, `${path}.anyOf[${index}]`, depth, tally)
    })
  }
  const defs = node['$defs']
  if (isObject(defs)) {
    for (const [name, def] of Object.entries(defs)) {
      tally.chars += name.length
      walkStrict(def, namePath(`${path}.$defs`, name), 1, tally)
    }
  }
}

/**
 * Check a schema OpenAI will receive with `strict: true`: core's profile check
 * (standard dialect included), then the strict-mode structure and size limits.
 *
 * @throws {LlmError} `kind: 'bad_request'` naming the offending path.
 */
export function assertOpenAiStrictSchema(schema: JsonValue, path: string): void {
  assertJsonSchemaProfile(schema, path, OPENAI_JSON_SCHEMA_PROFILE)
  if (!isObject(schema) || !isObjectSchema(schema) || Array.isArray(schema['type'])) {
    throw bad(`${path}: the root of an OpenAI strict schema must be { type: "object" }.`)
  }
  if (schema['anyOf'] !== undefined) {
    throw bad(`${path}.anyOf: the root of an OpenAI strict schema cannot be anyOf.`)
  }
  const tally: Tally = { properties: 0, chars: 0, enumValues: 0 }
  walkStrict(schema, path, 1, tally)
  const limits = OPENAI_STRICT_SCHEMA_LIMITS
  if (tally.properties > limits.maxObjectProperties) {
    throw bad(
      `${path}: ${tally.properties} object properties; OpenAI strict schemas allow at most ${limits.maxObjectProperties}.`,
    )
  }
  if (tally.chars > limits.maxSchemaStringChars) {
    throw bad(
      `${path}: ${tally.chars} characters across property names, definition names and enum values; OpenAI strict schemas allow at most ${limits.maxSchemaStringChars}.`,
    )
  }
  if (tally.enumValues > limits.maxEnumValues) {
    throw bad(
      `${path}: ${tally.enumValues} enum values; OpenAI strict schemas allow at most ${limits.maxEnumValues}.`,
    )
  }
}
