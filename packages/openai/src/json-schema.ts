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
 * - `const` is admitted: the guide counts it toward the size limit ("total
 *   string length of all property names, definition names, enum values, and
 *   const values cannot exceed 120,000 characters"), so its string values are
 *   counted there.
 * - Not named by the guide, so rejected: `oneOf`, `prefixItems`, `minLength`,
 *   `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`,
 *   `patternProperties`, a constraining `propertyNames`.
 * - Strict-mode structure: "the root level object of a schema must be an
 *   object, and not use `anyOf`", read as `type: "object"` exactly; "all fields
 *   or function parameters must be specified as `required`", read as `required`
 *   naming exactly the property names, each once (a name with no property is
 *   rejected too); "`additionalProperties: false` must always be set in
 *   objects". The guide does not say whether a nested object must declare
 *   `type`; every example on the page does, and an untyped schema is not a
 *   documented shape, so any schema using an object keyword (`properties`,
 *   `required`, `additionalProperties`) must declare `type: "object"` (or
 *   `["object", "null"]` below the root).
 * - Limits: "up to 5000 object properties total, with up to 10 levels of
 *   nesting"; 120,000 characters as quoted above; "up to 1000 enum values across
 *   all enum properties"; and, per enum, "For a single enum property with string
 *   values, the total string length of all enum values cannot exceed 15,000
 *   characters when there are more than 250 enum values." (checked on each
 *   `enum` on its own, never summed across the schema).
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
    'const',
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
  /** Per enum: applies to one `enum` with more than {@link maxEnumValuesBeforeCharCap} values. */
  maxEnumStringChars: 15_000,
  maxEnumValuesBeforeCharCap: 250,
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

const OBJECT_KEYWORDS = ['properties', 'required', 'additionalProperties'] as const

/** The node declares `type: "object"` (or a type list that includes it). */
function declaresObject(node: JsonObject): boolean {
  const type = node['type']
  return type === 'object' || (Array.isArray(type) && type.includes('object'))
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
    let ownChars = 0
    for (const value of enumValues) {
      if (typeof value === 'string') {
        tally.chars += value.length
        ownChars += value.length
      }
    }
    const limits = OPENAI_STRICT_SCHEMA_LIMITS
    if (
      enumValues.length > limits.maxEnumValuesBeforeCharCap &&
      ownChars > limits.maxEnumStringChars
    ) {
      throw bad(
        `${path}.enum: ${enumValues.length} values totalling ${ownChars} characters; a single enum with more than ${limits.maxEnumValuesBeforeCharCap} values may hold at most ${limits.maxEnumStringChars} characters of them in an OpenAI strict schema.`,
      )
    }
  }
  const constValue = node['const']
  if (typeof constValue === 'string') tally.chars += constValue.length
  const objectKeyword = OBJECT_KEYWORDS.find((key) => node[key] !== undefined)
  if (objectKeyword !== undefined && !declaresObject(node)) {
    throw bad(
      `${path}: a schema with ${objectKeyword} must declare type: "object" in an OpenAI strict schema.`,
    )
  }
  if (declaresObject(node)) {
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
    const extra = required.filter(
      (name, i) =>
        typeof name !== 'string' || !names.includes(name) || required.indexOf(name) !== i,
    )
    if (extra.length > 0) {
      throw bad(
        `${path}.required: an OpenAI strict schema's required list must name exactly its properties, each once; [${extra
          .map((name) => JSON.stringify(name))
          .join(', ')}] is not a property or is repeated.`,
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
  if (!isObject(schema) || schema['type'] !== 'object') {
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
      `${path}: ${tally.chars} characters across property names, definition names, enum values and const values; OpenAI strict schemas allow at most ${limits.maxSchemaStringChars}.`,
    )
  }
  if (tally.enumValues > limits.maxEnumValues) {
    throw bad(
      `${path}: ${tally.enumValues} enum values; OpenAI strict schemas allow at most ${limits.maxEnumValues}.`,
    )
  }
}
