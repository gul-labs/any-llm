/**
 * output-schema.ts — shared JSON Schema traversal + OpenAI-strict
 * output-schema preflight/rewrite helpers for `@gullabs/codex-cli`.
 *
 * Backs both:
 * - {@link assertOpenAiStrictOutputSchema} — the adapter's local preflight
 *   (D1), which REJECTS non-compliant schemas with a typed `bad_request`
 *   before ever shelling out to `codex`.
 * - {@link toOpenAiStrictOutputSchema} — an explicit, opt-in rewriting
 *   helper (D2) that the adapter never calls itself. Callers who want a
 *   caller-supplied schema massaged into compliance opt in at the call
 *   site.
 *
 * Both are built on ONE shared recursive walker
 * ({@link walkOutputSchemaNodes}) so the set of subschema positions they
 * see can never drift apart.
 *
 * ## Backend rules (live-verified 2026-07-09 against the real `codex`
 * binary + backend, 12 probes — see `docs/archive/openai-strict-output-schema-plan.md`)
 *
 * codex CLI's `--output-schema` mode is backed by the OpenAI Responses API
 * structured-outputs validator. As of the 2026-07-09 probes it rejects
 * (HTTP 400 `invalid_json_schema`, after a full network round-trip)
 * exactly two structural violations:
 *
 * 1. Every object node (root and nested) must carry
 *    `additionalProperties: false`.
 * 2. `required` must be supplied and include **every** key in `properties`
 *    on that same node.
 *
 * Everything else probed is accepted: `format`, `minLength`, `pattern`
 * (enforced), `default` (accepted, ignored), `anyOf`, `$defs`/`$ref`,
 * `enum`/`const` (enforced), nullable via `type: [T, 'null']`. These
 * claims are time-bounded to the 2026-07-09 probe date, not a timeless
 * product guarantee.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Shared walker
// ---------------------------------------------------------------------------

/**
 * The COMPLETE set of JSON Schema draft-2020-12 subschema positions this
 * walker visits, through which an object node can be reached: the full
 * applicator + content vocabulary subschema keywords, plus the
 * core-vocabulary reference containers `$defs` and legacy `definitions`.
 *
 * Pinned and tested for completeness in `output-schema.test.ts` — any
 * future omission of an enumerated position fails CI rather than silently
 * narrowing traversal coverage. The backend validates the whole schema
 * document (its error paths are arbitrary `In context=(...)` tuples), so a
 * walker that skips any subschema position silently misses nodes the
 * backend will reject.
 */
export const OUTPUT_SCHEMA_WALK_KEYWORDS = [
  'properties',
  'patternProperties',
  'additionalProperties',
  'items',
  'prefixItems',
  'contains',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
  '$defs',
  'definitions',
] as const

function isPlainObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
}

function isSchemaArray(value: JsonValue | undefined): value is JsonValue[] {
  return Array.isArray(value)
}

/** `true` when `node` looks like a JSON Schema object-type node. */
function isObjectSchemaNode(node: Record<string, JsonValue>): boolean {
  return node.type === 'object' || 'properties' in node
}

/**
 * Visit `schema` and every reachable subschema node, calling `onNode` for
 * each plain-object schema node encountered (parent before children).
 *
 * Recurses into every position enumerated by
 * {@link OUTPUT_SCHEMA_WALK_KEYWORDS}: `properties` values,
 * `patternProperties` values, `additionalProperties` (when a schema, not a
 * boolean), `items` (single-schema or tuple/array form), `prefixItems`
 * members, `contains`, `anyOf`/`oneOf`/`allOf` members, `not`,
 * `if`/`then`/`else`, `dependentSchemas` values, `propertyNames`,
 * `unevaluatedProperties`/`unevaluatedItems` (when schemas), `contentSchema`,
 * and `$defs`/`definitions` values.
 *
 * `onNode` may mutate `node` in place (used by
 * {@link toOpenAiStrictOutputSchema}) — the walker always re-reads the
 * current state of `schema`'s own keys when recursing, so in-place edits to
 * a node's own fields are visible to its own recursion step.
 */
export function walkOutputSchemaNodes(
  schema: JsonValue | undefined,
  path: string,
  onNode: (node: Record<string, JsonValue>, path: string) => void,
): void {
  if (!isPlainObject(schema)) return

  onNode(schema, path)

  const withPrefix = (segment: string): string =>
    path.length > 0 ? `${path}.${segment}` : segment

  const recurse = (value: JsonValue | undefined, segment: string): void => {
    walkOutputSchemaNodes(value, withPrefix(segment), onNode)
  }

  const recurseArray = (value: JsonValue | undefined, keyword: string): void => {
    if (!isSchemaArray(value)) return
    value.forEach((member, index) => {
      recurse(member, `${keyword}[${index}]`)
    })
  }

  const recurseMap = (value: JsonValue | undefined, keyword: string): void => {
    if (!isPlainObject(value)) return
    for (const [key, member] of Object.entries(value)) {
      recurse(member, `${keyword}.${key}`)
    }
  }

  recurseMap(schema.properties, 'properties')
  recurseMap(schema.patternProperties, 'patternProperties')
  if (isPlainObject(schema.additionalProperties)) {
    recurse(schema.additionalProperties, 'additionalProperties')
  }

  if (isSchemaArray(schema.items)) {
    recurseArray(schema.items, 'items')
  } else if (schema.items !== undefined) {
    recurse(schema.items, 'items')
  }

  recurseArray(schema.prefixItems, 'prefixItems')
  recurse(schema.contains, 'contains')

  recurseArray(schema.anyOf, 'anyOf')
  recurseArray(schema.oneOf, 'oneOf')
  recurseArray(schema.allOf, 'allOf')

  if (schema.not !== undefined) recurse(schema.not, 'not')
  if (schema.if !== undefined) recurse(schema.if, 'if')
  if (schema.then !== undefined) recurse(schema.then, 'then')
  if (schema.else !== undefined) recurse(schema.else, 'else')

  recurseMap(schema.dependentSchemas, 'dependentSchemas')
  if (schema.propertyNames !== undefined) recurse(schema.propertyNames, 'propertyNames')

  if (isPlainObject(schema.unevaluatedProperties)) {
    recurse(schema.unevaluatedProperties, 'unevaluatedProperties')
  }
  if (isPlainObject(schema.unevaluatedItems)) {
    recurse(schema.unevaluatedItems, 'unevaluatedItems')
  }
  if (schema.contentSchema !== undefined) recurse(schema.contentSchema, 'contentSchema')

  recurseMap(schema.$defs, '$defs')
  recurseMap(schema.definitions, 'definitions')
}

// ---------------------------------------------------------------------------
// D1 — assertOpenAiStrictOutputSchema (local preflight)
// ---------------------------------------------------------------------------

function displayPathOf(path: string): string {
  return path.length > 0 ? path : '<root>'
}

function isStringArray(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Rule 1 pass — every object node must carry an explicit `additionalProperties: false`. */
function assertRuleOneAdditionalProperties(schema: JsonValue, rootPath: string): void {
  walkOutputSchemaNodes(schema, rootPath, (node, path) => {
    if (isObjectSchemaNode(node) && node.additionalProperties !== false) {
      throw new LlmError(
        `codex-cli requires \`additionalProperties: false\` to be explicitly set on every object-schema node in outputJsonSchema — codex's --output-schema mode 400s without it, and this adapter will not silently inject or rewrite caller-provided schemas. Missing at \`${displayPathOf(path)}\`. Set \`additionalProperties: false\` on that node and retry.`,
        { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
      )
    }
  })
}

/**
 * Rule 2 pass — every object node with a `properties` object must have a
 * `required` array (string values only) that lists every property key.
 * Run only after {@link assertRuleOneAdditionalProperties} has cleared
 * the whole tree, so rule-1 violations always surface with their original
 * (unwidened-by-rule-2) path first.
 */
function assertRequiredCoversPropertiesDeep(schema: JsonValue, rootPath: string): void {
  walkOutputSchemaNodes(schema, rootPath, (node, path) => {
    if (!isPlainObject(node.properties)) return

    const propertyKeys = Object.keys(node.properties)
    const required = node.required

    if (required !== undefined && !isStringArray(required)) {
      throw new LlmError(
        `codex-cli requires \`required\` to be an array of property-name strings on every object-schema node that has \`properties\` in outputJsonSchema — codex's --output-schema mode 400s otherwise, and this adapter will not silently inject or rewrite caller-provided schemas. Malformed \`required\` at \`${displayPathOf(path)}\`.`,
        { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
      )
    }

    const requiredSet = new Set<string>(required === undefined ? [] : required)
    for (const key of propertyKeys) {
      if (!requiredSet.has(key)) {
        throw new LlmError(
          `codex-cli requires \`required\` to be an array including every key in \`properties\` on every object-schema node in outputJsonSchema — codex's --output-schema mode 400s otherwise, and this adapter will not silently inject or rewrite caller-provided schemas. Missing '${key}' from \`required\` at \`${displayPathOf(path)}\`. Every property must be listed in \`required\`; express optionality as a null union — see \`toOpenAiStrictOutputSchema\`.`,
          { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
        )
      }
    }
  })
}

/**
 * Local preflight for codex's `--output-schema` mode.
 *
 * Enforces the two live-verified backend rules (see the module docstring)
 * over the COMPLETE draft-2020-12 subschema traversal
 * ({@link OUTPUT_SCHEMA_WALK_KEYWORDS}):
 *
 * 1. Every object node must carry `additionalProperties: false`.
 * 2. Every object node with a `properties` object must have a `required`
 *    array listing every property key.
 *
 * Rejects ONLY these two rules — nothing the 2026-07-09 probes did not
 * observe the backend reject. Never mutates or clones `schema` — this
 * function only validates; the schema is passed through byte-identical
 * (same object reference) by the adapter.
 *
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's JSON
 *   path (rule 1: the node missing `additionalProperties: false`; rule 2:
 *   the node and the first property key missing from `required`).
 */
export function assertOpenAiStrictOutputSchema(schema: JsonValue): void {
  assertRuleOneAdditionalProperties(schema, '')
  assertRequiredCoversPropertiesDeep(schema, '')
}

// ---------------------------------------------------------------------------
// D2 — toOpenAiStrictOutputSchema (explicit opt-in rewriting helper)
// ---------------------------------------------------------------------------

/**
 * Rewrites `propSchema` (a previously-optional property schema) so it
 * admits `null`, preserving caller intent (optional ⇒ nullable-required,
 * per OpenAI's own strict-mode guidance) instead of silently making the
 * value mandatory.
 *
 * - `type: T` (string) → `type: [T, 'null']`.
 * - `type: [...]` (array) already containing `'null'` → left untouched
 *   (same reference); otherwise `'null'` is appended.
 * - No `type` keyword at all (e.g. a bare `anyOf` member, `$ref`, or an
 *   otherwise-untyped object schema) → wrapped as
 *   `{ anyOf: [<original>, { type: 'null' }] }` so the original schema's
 *   own constraints are preserved verbatim inside the union.
 */
function makeNullable(propSchema: JsonValue): JsonValue {
  if (!isPlainObject(propSchema)) {
    return { anyOf: [propSchema, { type: 'null' }] }
  }

  const type = propSchema.type
  if (typeof type === 'string') {
    if (type === 'null') return propSchema
    return { ...propSchema, type: [type, 'null'] }
  }
  if (Array.isArray(type)) {
    if (type.includes('null')) return propSchema
    return { ...propSchema, type: [...type, 'null'] }
  }

  return { anyOf: [propSchema, { type: 'null' }] }
}

/** Mutates `node` in place: injects `additionalProperties: false` + completes `required`. */
function transformObjectNode(node: Record<string, JsonValue>, path: string): void {
  if (isObjectSchemaNode(node)) {
    const additionalProperties = node.additionalProperties
    if (additionalProperties === true || isPlainObject(additionalProperties)) {
      throw new LlmError(
        `toOpenAiStrictOutputSchema cannot rewrite an explicit \`additionalProperties: true\` (or schema-valued \`additionalProperties\`) at \`${displayPathOf(path)}\` — rewriting an explicit contradiction would silently invert your intent. Remove \`additionalProperties\` (the helper will inject \`false\`) or set it to \`false\` yourself.`,
        { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
      )
    }
    if (additionalProperties === undefined) {
      node.additionalProperties = false
    }
  }

  if (!isPlainObject(node.properties)) return

  const properties = node.properties
  const propertyKeys = Object.keys(properties)
  const required = node.required

  if (required !== undefined && !isStringArray(required)) {
    throw new LlmError(
      `toOpenAiStrictOutputSchema cannot rewrite a malformed \`required\` (must be an array of property-name strings) at \`${displayPathOf(path)}\` — a malformed \`required\` is not optionality intent, and rewriting it would be guessing.`,
      { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
    )
  }

  const requiredList: string[] = required === undefined ? [] : [...required]
  const requiredSet = new Set(requiredList)

  for (const key of propertyKeys) {
    if (requiredSet.has(key)) continue
    properties[key] = makeNullable(properties[key] as JsonValue)
    requiredList.push(key)
    requiredSet.add(key)
  }

  node.required = requiredList
}

/**
 * Explicit, opt-in rewriter that transforms a caller-supplied JSON Schema
 * into one that passes {@link assertOpenAiStrictOutputSchema}.
 *
 * This is a provider-surface-specific structured-OUTPUT-schema transformer
 * with the opinionated semantics documented below — not a generic
 * "make this schema OpenAI-compatible" canonicalizer.
 *
 * Pure: deep-clones `schema` (via `structuredClone`) and never mutates the
 * input. The adapter NEVER calls this itself — callers opt in explicitly
 * at the call site.
 *
 * Transform (applied recursively via the same {@link walkOutputSchemaNodes}
 * walker the preflight uses):
 *
 * 1. Every object node gets `additionalProperties: false` injected, but
 *    ONLY when the keyword is absent. An explicit `additionalProperties:
 *    true` or a schema-valued `additionalProperties` is REJECTED with
 *    `bad_request` — rewriting an explicit contradiction would silently
 *    invert caller intent.
 * 2. For every object node with `properties`: `required` is treated as the
 *    empty list when absent (every property is optional and remediated).
 *    A present-but-malformed `required` (not an array of strings) is
 *    REJECTED with `bad_request` naming the node path — a malformed
 *    keyword is not optionality intent, and rewriting it would be
 *    guessing. Otherwise, every key missing from `required` is added to
 *    `required`, and — **semantic change**: an optional property becomes a
 *    NULLABLE required property, not merely a mandatory one — its schema
 *    gains `null` as an admissible type (`type: T` → `type: [T, 'null']`;
 *    an already-nullable `type` array is left untouched; a property with
 *    no `type` keyword at all is wrapped as
 *    `anyOf: [<original>, { type: 'null' }]`).
 *
 * The result is guaranteed to pass {@link assertOpenAiStrictOutputSchema}.
 *
 * As of the 2026-07-09 live probes, xai/grok's `strict: true` performs no
 * compile-time schema validation and does NOT need this helper — see
 * `packages/xai/README.md`. This is a time-bounded observation about that
 * provider's behavior on that date, not a timeless product guarantee.
 *
 * @throws {LlmError} `kind: 'bad_request'` — explicit
 *   `additionalProperties: true`/schema, or a malformed `required`.
 */
export function toOpenAiStrictOutputSchema(schema: JsonValue): JsonValue {
  const cloned = structuredClone(schema)
  walkOutputSchemaNodes(cloned, '', (node, path) => {
    transformObjectNode(node, path)
  })
  return cloned
}
