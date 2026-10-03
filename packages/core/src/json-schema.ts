/**
 * json-schema.ts — the library's one JSON Schema contract (ADR-034).
 *
 * `output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema
 * (2020-12 subset). Three layers, all fail-closed (`LlmError` `bad_request`
 * naming the offending path, before dispatch, never rewriting the schema):
 *
 * 1. {@link assertStandardJsonSchema}: dialect mistakes. The OpenAPI
 *    `nullable` keyword, uppercase type names and boolean subschemas.
 * 2. {@link assertJsonSchemaProfile}: a provider's declared profile, the
 *    keywords it enforces. Anything else is a constraint the provider would
 *    silently ignore (or reinterpret), so it is rejected, not forwarded.
 * 3. {@link assertPortableJsonSchema}: the portable subset, the profile every
 *    shipped provider enforces, for hosts that route one schema to several.
 *
 * Keywords fall into three classes. **Annotations** constrain nothing and are
 * accepted everywhere. **Applicators** and **assertions** are checked against
 * the profile. The walk inspects schema positions only, so a property named
 * `nullable`, or an `enum` / `const` / `default` / `examples` value that looks
 * like a keyword, is data and never flagged.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'

type JsonObject = { [k: string]: JsonValue }

/** Keywords that constrain nothing: accepted on every provider and passed through. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
])

const JSON_SCHEMA_TYPES: ReadonlySet<string> = new Set([
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
  'additionalItems',
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

/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ['prefixItems', 'anyOf', 'oneOf', 'allOf'] as const

/** Keywords whose value maps arbitrary names to subschemas. */
const SCHEMA_MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  'dependentSchemas',
  // Draft-07 `dependencies`: schema-valued entries are walked; array-valued
  // entries are property-name lists and are skipped by the object check.
  'dependencies',
  '$defs',
  'definitions',
] as const

/**
 * Single-subschema keywords whose own boolean form is a documented, probed
 * shape: `additionalProperties: false` closes an object, `items: false` closes
 * a tuple. Every other boolean subschema is rejected.
 */
const BOOLEAN_FORM_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalProperties',
  'items',
])

/**
 * What a provider enforces. Declared by the adapter from the provider's own
 * documentation (read date in the adapter) and live probes. A keyword outside
 * `keywords` (and outside the annotations) is rejected.
 */
export interface JsonSchemaProfile {
  /** Provider id used in messages and on the error. Absent for the portable subset. */
  readonly provider?: string
  /** Assertions and applicators the provider enforces. Annotations are always accepted. */
  readonly keywords: readonly string[]
  /** Values of `format` the provider enforces. Any other value is rejected. */
  readonly formats: readonly string[]
  /**
   * Largest enforced value per keyword (e.g. `maxLength: 2048`). A larger value
   * is a constraint the provider accepts but does not enforce, so it is rejected.
   */
  readonly limits: Readonly<Record<string, number>>
  /** False when `$ref` cycles (recursive schemas) are not supported. */
  readonly circularRefs: boolean
  /** True when `items: false` (closed tuple) is enforced. */
  readonly booleanItems: boolean
  /**
   * True when `pattern` is limited to the ECMAScript subset both shipped
   * providers compile: no backreferences, property escapes, word boundaries,
   * lookaround or inline modifiers.
   */
  readonly patternSubset: boolean
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function badSchema(message: string, provider: string | undefined): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    ...(provider !== undefined ? { provider } : {}),
  })
}

function childPath(path: string, segment: string): string {
  return `${path}.${segment}`
}

/** One subschema position found under a node. */
interface Subschema {
  readonly value: JsonValue
  readonly path: string
  readonly keyword: string
}

/** Every subschema position directly under `node`, in a stable order. */
function subschemasOf(node: JsonObject, path: string): Subschema[] {
  const found: Subschema[] = []
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = node[keyword]
    if (!isPlainObject(map)) continue
    for (const [key, member] of Object.entries(map)) {
      if (keyword === 'dependencies' && Array.isArray(member)) continue
      found.push({ value: member, path: childPath(path, `${keyword}.${key}`), keyword })
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const members = node[keyword]
    if (!Array.isArray(members)) continue
    members.forEach((member, index) =>
      found.push({
        value: member,
        path: childPath(path, `${keyword}[${index}]`),
        keyword,
      }),
    )
  }
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const member = node[keyword]
    if (member === undefined) continue
    if (keyword === 'items' && Array.isArray(member)) {
      member.forEach((entry, index) =>
        found.push({ value: entry, path: childPath(path, `items[${index}]`), keyword }),
      )
      continue
    }
    found.push({ value: member, path: childPath(path, keyword), keyword })
  }
  return found
}

// ---------------------------------------------------------------------------
// Layer 1: dialect
// ---------------------------------------------------------------------------

function assertNodeDialect(node: JsonObject, path: string, provider: string | undefined) {
  if ('nullable' in node) {
    throw badSchema(
      `${path}: standard JSON Schema has no \`nullable\` keyword (found at that node). Providers ignore it, so the field would be required and non-null and the model could not say "unknown". List 'null' in \`type\` instead, e.g. type: ['string', 'null'].`,
      provider,
    )
  }
  const type = node['type']
  if (type !== undefined) {
    const names = Array.isArray(type) ? type : [type]
    for (const name of names) {
      if (typeof name !== 'string' || !JSON_SCHEMA_TYPES.has(name)) {
        throw badSchema(
          `${path}: \`type\` ${JSON.stringify(
            name,
          )} is not a JSON Schema type. Use lowercase string, number, integer, boolean, object, array or null (the OpenAPI dialect's uppercase names are not accepted).`,
          provider,
        )
      }
    }
  }
  if (Array.isArray(node['items'])) {
    throw badSchema(
      `${path}.items: \`items\` as an array is the draft-07 tuple form. Use \`prefixItems\` for tuples.`,
      provider,
    )
  }
}

function walkDialect(
  value: JsonValue,
  path: string,
  keyword: string | undefined,
  provider: string | undefined,
): void {
  if (typeof value === 'boolean') {
    if (keyword !== undefined && BOOLEAN_FORM_KEYWORDS.has(keyword)) return
    throw badSchema(
      `${path}: boolean subschemas are not accepted (found \`${String(value)}\`). Use an explicit schema object; \`additionalProperties\` and \`items\` are the only keywords that take a boolean.`,
      provider,
    )
  }
  if (!isPlainObject(value)) return
  assertNodeDialect(value, path, provider)
  for (const sub of subschemasOf(value, path)) {
    walkDialect(sub.value, sub.path, sub.keyword, provider)
  }
}

/**
 * Reject an output or tool schema written in the OpenAPI / Gemini dialect.
 *
 * Rejects `nullable`, uppercase or unknown `type` names, `items` in its
 * draft-07 array form and boolean subschemas (except the `additionalProperties`
 * and `items` boolean forms). Only schema positions are inspected. Never
 * mutates `schema`. A non-object `schema` is ignored: the engine owns that check.
 *
 * @param path Where the schema sits in the request (`output.jsonSchema`,
 *   `tools[0].inputJsonSchema`); the offending node's path is appended.
 * @param options.provider Provider id placed on the error.
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's path.
 */
export function assertStandardJsonSchema(
  schema: JsonValue,
  path: string,
  options?: { readonly provider?: string },
): void {
  if (isPlainObject(schema)) walkDialect(schema, path, undefined, options?.provider)
}

// ---------------------------------------------------------------------------
// Layer 2: provider profile
// ---------------------------------------------------------------------------

/**
 * Hints for the keywords hosts most often reach for that no provider enforces.
 * Shown after the generic rejection; the library never performs the rewrite.
 */
const KEYWORD_HINTS: Readonly<Record<string, string>> = {
  const:
    "Use `enum` with one value instead (Zod: `z.enum(['x'])` rather than `z.literal('x')`).",
  oneOf:
    'Providers read `oneOf` as `anyOf`, which drops the exclusive-match rule. Use `anyOf`.',
  allOf: 'Merge the subschemas into one schema.',
  propertyNames:
    'Constrain map keys in host-side validation (Zod: `z.record` emits `propertyNames`).',
  exclusiveMinimum: 'Use `minimum` and adjust the bound.',
  exclusiveMaximum: 'Use `maximum` and adjust the bound.',
  nullable: "List 'null' in `type` instead.",
}

function describeProvider(profile: JsonSchemaProfile): string {
  return profile.provider ?? 'the portable subset'
}

function assertNodeProfile(node: JsonObject, path: string, profile: JsonSchemaProfile) {
  const who = describeProvider(profile)
  const allowed = profile.keywords

  for (const keyword of Object.keys(node)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue
    if (allowed.includes(keyword)) continue
    const hint = KEYWORD_HINTS[keyword]
    throw badSchema(
      `${path}: ${who} does not enforce the JSON Schema keyword \`${keyword}\`; it would be accepted and ignored, or reinterpreted, so the output would not be constrained. ${
        hint ?? 'Remove it and validate that constraint host-side.'
      }`,
      profile.provider,
    )
  }

  const type = node['type']
  if (Array.isArray(type)) {
    const nonNull = type.filter((name) => name !== 'null')
    if (!(type.length === 2 && nonNull.length === 1)) {
      throw badSchema(
        `${path}: ${who} is only verified with \`type\` arrays of one type plus 'null' (type: ['string', 'null']); got ${JSON.stringify(
          type,
        )}. Express any other union with \`anyOf\`.`,
        profile.provider,
      )
    }
  }

  for (const keyword of ['enum', 'anyOf'] as const) {
    const value = node[keyword]
    if (Array.isArray(value) && value.length === 0) {
      throw badSchema(
        `${path}: \`${keyword}\` must list at least one variant.`,
        profile.provider,
      )
    }
  }

  const format = node['format']
  if (format !== undefined && !profile.formats.includes(format as string)) {
    throw badSchema(
      `${path}: ${who} enforces \`format\` only for [${profile.formats.join(
        ', ',
      )}]; ${JSON.stringify(format)} would be accepted and ignored. Remove it and validate host-side.`,
      profile.provider,
    )
  }

  for (const [keyword, limit] of Object.entries(profile.limits)) {
    const value = node[keyword]
    if (typeof value === 'number' && value > limit) {
      throw badSchema(
        `${path}: ${who} enforces \`${keyword}\` only up to ${limit}; ${value} would be accepted and not enforced. Lower it or validate host-side.`,
        profile.provider,
      )
    }
  }

  if (node['items'] === false && !profile.booleanItems) {
    throw badSchema(
      `${path}.items: ${who} does not enforce \`items: false\` (a closed tuple). Remove it; list the tuple in \`prefixItems\` and bound the length with \`minItems\`/\`maxItems\`, then validate host-side.`,
      profile.provider,
    )
  }

  const pattern = node['pattern']
  if (profile.patternSubset && typeof pattern === 'string') {
    const construct = unsupportedPatternConstruct(pattern)
    if (construct !== undefined) {
      throw badSchema(
        `${path}: \`pattern\` uses ${construct}, which is outside the regex subset ${who} enforces (backreferences, property escapes, word boundaries, lookaround and inline modifiers are not supported). Simplify the pattern or validate host-side.`,
        profile.provider,
      )
    }
  }
}

/**
 * First construct in `pattern` that is outside the regex subset both shipped
 * providers compile, or `undefined`. A character class is skipped as a unit.
 */
function unsupportedPatternConstruct(pattern: string): string | undefined {
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1] ?? ''
      i += 1
      if (inClass) continue
      if (/[1-9]/.test(next)) return `a backreference (\\${next})`
      if (next === 'k') return 'a named backreference (\\k)'
      if (next === 'p' || next === 'P') return `a property escape (\\${next})`
      if (next === 'b' || next === 'B') return `a word boundary (\\${next})`
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(' && pattern[i + 1] === '?') {
      const rest = pattern.slice(i + 2, i + 5)
      if (rest.startsWith(':')) continue
      if (rest.startsWith('=') || rest.startsWith('!')) return 'a lookahead'
      if (rest.startsWith('<=') || rest.startsWith('<!')) return 'a lookbehind'
      if (rest.startsWith('<')) continue // named capturing group
      return 'an inline modifier or conditional'
    }
  }
  return undefined
}

interface RefSite {
  readonly ref: string
  readonly path: string
}

function walkProfile(
  value: JsonValue,
  path: string,
  profile: JsonSchemaProfile,
  refs: RefSite[],
): void {
  if (!isPlainObject(value)) return
  assertNodeProfile(value, path, profile)
  const ref = value['$ref']
  if (ref !== undefined) {
    if (typeof ref !== 'string') {
      throw badSchema(`${path}: \`$ref\` must be a string.`, profile.provider)
    }
    refs.push({ ref, path })
  }
  for (const sub of subschemasOf(value, path)) {
    walkProfile(sub.value, sub.path, profile, refs)
  }
}

function resolvePointer(root: JsonObject, ref: string): JsonObject | undefined {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: JsonValue = root
  for (const raw of ref.slice(2).split('/')) {
    let segment = raw
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    segment = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index] as JsonValue
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment] as JsonValue
    } else {
      return undefined
    }
  }
  return isPlainObject(current) ? current : undefined
}

/** `$ref` values found in the schema positions under `node`, skipping `$defs` maps when asked. */
function collectRefs(node: JsonObject, skipDefs: boolean, out: string[]): void {
  const ref = node['$ref']
  if (typeof ref === 'string') out.push(ref)
  for (const sub of subschemasOf(node, '')) {
    if (skipDefs && (sub.keyword === '$defs' || sub.keyword === 'definitions')) continue
    if (isPlainObject(sub.value)) collectRefs(sub.value, skipDefs, out)
  }
}

function assertRefs(
  root: JsonObject,
  rootPath: string,
  refs: readonly RefSite[],
  profile: JsonSchemaProfile,
): void {
  for (const site of refs) {
    if (!site.ref.startsWith('#')) {
      throw badSchema(
        `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} is not a local reference. Only same-document references ("#/$defs/Name" or "#") are accepted.`,
        profile.provider,
      )
    }
    if (resolvePointer(root, site.ref) === undefined) {
      throw badSchema(
        `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} does not resolve to a schema in ${rootPath}.`,
        profile.provider,
      )
    }
  }
  if (profile.circularRefs) return

  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (pointer: string, via: string): void => {
    const status = state.get(pointer)
    if (status === 'done') return
    if (status === 'visiting') {
      throw badSchema(
        `${via}: \`$ref\` ${JSON.stringify(pointer)} is circular (a recursive schema). ${describeProvider(
          profile,
        )} supports non-circular references only.`,
        profile.provider,
      )
    }
    state.set(pointer, 'visiting')
    const target = resolvePointer(root, pointer)
    if (target !== undefined) {
      const inner: string[] = []
      collectRefs(target, pointer === '#', inner)
      for (const next of inner) visit(next, via)
    }
    state.set(pointer, 'done')
  }
  visit('#', rootPath)
}

/**
 * Check a schema against a provider's declared profile, after the dialect
 * check. Adapters call this on `output.jsonSchema` and every tool's
 * `inputJsonSchema`; a keyword the provider does not enforce is a
 * `bad_request` naming its path, never a warning.
 *
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's path.
 */
export function assertJsonSchemaProfile(
  schema: JsonValue,
  path: string,
  profile: JsonSchemaProfile,
): void {
  assertStandardJsonSchema(schema, path, {
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
  })
  if (!isPlainObject(schema)) return
  const refs: RefSite[] = []
  walkProfile(schema, path, profile, refs)
  assertRefs(schema, path, refs, profile)
}

// ---------------------------------------------------------------------------
// Layer 3: portable subset
// ---------------------------------------------------------------------------

/**
 * The portable subset: keywords every shipped provider enforces. The
 * intersection of the Google and xAI profiles (ADR-034 publishes the table;
 * a test in `@gullabs/any-llm` keeps this equal to that intersection).
 * Annotations are accepted on top of these.
 */
export const PORTABLE_JSON_SCHEMA_KEYWORDS: readonly string[] = [
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
]

/** `format` values enforced by every shipped provider. */
export const PORTABLE_JSON_SCHEMA_FORMATS: readonly string[] = [
  'date-time',
  'date',
  'time',
  'email',
]

const PORTABLE_PROFILE: JsonSchemaProfile = {
  keywords: PORTABLE_JSON_SCHEMA_KEYWORDS,
  formats: PORTABLE_JSON_SCHEMA_FORMATS,
  // The smaller of the providers' limits (only xAI declares any).
  limits: { minLength: 2048, maxLength: 2048, minItems: 256, maxItems: 256 },
  circularRefs: false,
  booleanItems: false,
  patternSubset: true,
}

/**
 * Lint a schema against the portable subset, so a schema that routes to any
 * shipped provider is known to be enforced by all of them. Intended for a
 * host build-time test over every call site; adapters do not call it.
 *
 * @param path Label used in messages (default `schema`).
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's path.
 */
export function assertPortableJsonSchema(schema: JsonValue, path = 'schema'): void {
  assertJsonSchemaProfile(schema, path, PORTABLE_PROFILE)
}
