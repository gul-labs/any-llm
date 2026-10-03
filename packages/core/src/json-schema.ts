/**
 * json-schema.ts — the library's one JSON Schema contract (ADR-034).
 *
 * `output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema
 * (2020-12 subset). Three layers, all fail-closed (`LlmError` `bad_request`
 * naming the offending path, before dispatch, never rewriting the schema):
 *
 * 1. {@link assertStandardJsonSchema}: dialect and shape mistakes. The OpenAPI
 *    `nullable` keyword, uppercase type names, boolean subschemas, a value in a
 *    schema position that is not a schema, malformed keyword values, a cyclic
 *    or absurdly deep object.
 * 2. {@link assertJsonSchemaProfile}: a provider's declared profile, the
 *    keywords it enforces. Anything else is a constraint the provider would
 *    silently ignore (or reinterpret), so it is rejected, not forwarded.
 * 3. {@link assertPortableJsonSchema}: the portable subset, the intersection of
 *    the Gemini 3.x and xAI profiles, for hosts that route one schema to both.
 *    It says nothing about Gemma (a stricter profile) or the CLI providers
 *    (`claude-cli` and `codex-cli` do not run these checks).
 *
 * Keywords fall into three classes. **Annotations** constrain nothing and are
 * accepted by every profile. **Applicators** and **assertions** are checked
 * against the profile. The walk inspects schema positions only, so a property
 * named `nullable`, or an `enum` / `const` / `default` / `examples` value that
 * looks like a keyword, is data and never flagged.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'

type JsonObject = { [k: string]: JsonValue }

/** Nesting deeper than this is rejected: no real schema is this deep. */
const MAX_SCHEMA_DEPTH = 128

/** Keywords that constrain nothing: accepted by every profile and passed through. */
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
  // entries are property-name lists and are skipped.
  'dependencies',
  '$defs',
  'definitions',
] as const

/** The maps that hold named definitions a `$ref` can point at. */
const DEFINITION_KEYWORDS: ReadonlySet<string> = new Set(['$defs', 'definitions'])

/**
 * Single-subschema keywords whose own boolean form is a documented, probed
 * shape: `additionalProperties: false` closes an object, `items: false` closes
 * a tuple. Every other boolean subschema is rejected.
 */
const BOOLEAN_FORM_KEYWORDS: ReadonlySet<string> = new Set([
  'additionalProperties',
  'items',
])

/** Keywords whose value must be a non-negative integer. */
const COUNT_KEYWORDS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
] as const

/** Keywords whose value must be a finite number. */
const NUMBER_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const

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
   * True when `pattern` is limited to the ECMAScript subset the profile's
   * provider is known to compile: no backreferences, property escapes, word
   * boundaries, lookaround or inline modifiers. False only when a provider has
   * been shown to accept those constructs.
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

/** Short, single-line rendering of a value for an error message. */
function show(value: JsonValue): string {
  const text = JSON.stringify(value)
  return text.length > 40 ? `${text.slice(0, 37)}...` : text
}

/** Path to a keyword under a node: `a.b`. */
function childPath(path: string, segment: string): string {
  return `${path}.${segment}`
}

/**
 * Path to a user-chosen name (a property, a `$defs` entry). A name that holds
 * `.`, `[`, `]`, `"` or `\` is bracket-quoted (`properties["a.b"]`) so the path
 * cannot be read as a different location.
 */
function namePath(path: string, name: string): string {
  return /^[^.[\]"\\]+$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`
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
      found.push({
        value: member,
        path: namePath(childPath(path, keyword), key),
        keyword,
      })
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
    found.push({ value: member, path: childPath(path, keyword), keyword })
  }
  return found
}

// ---------------------------------------------------------------------------
// Layer 1: dialect and shape
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
  assertNodeShape(node, path, provider)
}

/** Keyword values that are the wrong JSON type or malformed: no provider can read them. */
function assertNodeShape(node: JsonObject, path: string, provider: string | undefined) {
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const value = node[keyword]
    if (value !== undefined && !isPlainObject(value)) {
      throw badSchema(
        `${path}: \`${keyword}\` must be an object mapping names to schemas (found ${show(value)}).`,
        provider,
      )
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const value = node[keyword]
    if (value !== undefined && !Array.isArray(value)) {
      throw badSchema(
        `${path}: \`${keyword}\` must be an array of schemas (found ${show(value)}).`,
        provider,
      )
    }
  }
  for (const keyword of COUNT_KEYWORDS) {
    const value = node[keyword]
    if (
      value !== undefined &&
      !(typeof value === 'number' && Number.isInteger(value) && value >= 0)
    ) {
      throw badSchema(
        `${path}: \`${keyword}\` must be a non-negative integer (found ${show(value)}).`,
        provider,
      )
    }
  }
  for (const keyword of NUMBER_KEYWORDS) {
    const value = node[keyword]
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) {
      throw badSchema(
        `${path}: \`${keyword}\` must be a number (found ${show(value)}).`,
        provider,
      )
    }
  }
  const required = node['required']
  if (
    required !== undefined &&
    !(Array.isArray(required) && required.every((name) => typeof name === 'string'))
  ) {
    throw badSchema(
      `${path}: \`required\` must be an array of property names (found ${show(required)}).`,
      provider,
    )
  }
  const enumValues = node['enum']
  if (enumValues !== undefined && !Array.isArray(enumValues)) {
    throw badSchema(
      `${path}: \`enum\` must be an array (found ${show(enumValues)}).`,
      provider,
    )
  }
  const format = node['format']
  if (format !== undefined && typeof format !== 'string') {
    throw badSchema(
      `${path}: \`format\` must be a string (found ${show(format)}).`,
      provider,
    )
  }
  const pattern = node['pattern']
  if (pattern !== undefined) {
    if (typeof pattern !== 'string') {
      throw badSchema(
        `${path}: \`pattern\` must be a string (found ${show(pattern)}).`,
        provider,
      )
    }
    try {
      new RegExp(pattern)
    } catch (cause) {
      throw badSchema(
        `${path}: \`pattern\` ${JSON.stringify(pattern)} is not a valid regular expression (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        provider,
      )
    }
  }
}

function walkDialect(
  value: JsonValue,
  path: string,
  keyword: string | undefined,
  provider: string | undefined,
  ancestors: Set<JsonObject>,
): void {
  if (typeof value === 'boolean') {
    if (keyword !== undefined && BOOLEAN_FORM_KEYWORDS.has(keyword)) return
    throw badSchema(
      `${path}: boolean subschemas are not accepted (found \`${String(value)}\`). Use an explicit schema object; \`additionalProperties\` and \`items\` are the only keywords that take a boolean.`,
      provider,
    )
  }
  if (!isPlainObject(value)) {
    throw badSchema(
      `${path}: a schema must be an object (found ${show(value)}).`,
      provider,
    )
  }
  if (ancestors.has(value)) {
    throw badSchema(
      `${path}: the schema object contains itself (a cyclic JavaScript object). Express recursion with \`$ref\` and \`$defs\`.`,
      provider,
    )
  }
  if (ancestors.size >= MAX_SCHEMA_DEPTH) {
    throw badSchema(
      `${path}: schemas nested more than ${MAX_SCHEMA_DEPTH} levels deep are not accepted. Flatten the schema or use \`$ref\` and \`$defs\`.`,
      provider,
    )
  }
  assertNodeDialect(value, path, provider)
  ancestors.add(value)
  for (const sub of subschemasOf(value, path)) {
    walkDialect(sub.value, sub.path, sub.keyword, provider, ancestors)
  }
  ancestors.delete(value)
}

/**
 * Reject an output or tool schema written in the OpenAPI / Gemini dialect, or
 * malformed.
 *
 * Rejects `nullable`, uppercase or unknown `type` names, `items` in its
 * draft-07 array form, boolean subschemas (except the `additionalProperties`
 * and `items` boolean forms), a value in a schema position that is not a
 * schema, malformed keyword values (a string-valued `maxLength`, an invalid
 * `pattern`, a `required` that is not a list of names), and a cyclic or more
 * than 128-deep object. Only schema positions are inspected. Never mutates
 * `schema`. A non-object `schema` is ignored: the engine owns that check.
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
  if (isPlainObject(schema)) {
    walkDialect(schema, path, undefined, options?.provider, new Set())
  }
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
    "Only `propertyNames: { type: 'string' }` (what `z.record(z.string(), X)` emits) is accepted, because it constrains nothing. Constrain map keys in host-side validation (Zod: `z.record(z.enum([...]), X)` and `z.record(z.string().regex(...), X)` emit a constraining `propertyNames`).",
  exclusiveMinimum: 'Use `minimum` and adjust the bound.',
  exclusiveMaximum: 'Use `maximum` and adjust the bound.',
  definitions:
    'Only the 2020-12 spelling is accepted: rename `definitions` to `$defs` and `$ref` pointers from `#/definitions/Name` to `#/$defs/Name`.',
  dependencies:
    'Draft-07 `dependencies` is not enforced by any provider. Validate the dependency host-side.',
  $anchor:
    'Anchors are not resolved. Point `$ref` at a `$defs` entry (`#/$defs/Name`) instead.',
}

/** What to do about the non-standard `format` values Zod's string checks emit next to a `pattern`. */
const ZOD_PATTERN_FORMAT_HINT =
  'Zod emits it next to a `pattern` that carries the constraint: keep the pattern and drop the `format` (write `z.string().regex(...)`, or chain `.meta({ format: undefined })` after the check).'
const FORMAT_HINTS: Readonly<Record<string, string>> = {
  starts_with: ZOD_PATTERN_FORMAT_HINT,
  ends_with: ZOD_PATTERN_FORMAT_HINT,
  includes: ZOD_PATTERN_FORMAT_HINT,
  duration:
    "Zod's `z.iso.duration()` pattern uses lookahead, which no portable profile enforces: validate durations host-side or write a simple `z.string().regex(...)`.",
}

function describeProvider(profile: JsonSchemaProfile): string {
  return profile.provider ?? 'the portable subset'
}

/**
 * `propertyNames: { type: 'string' }` constrains nothing: JSON object keys are
 * always strings. It is the one `propertyNames` accepted, because
 * `z.record(z.string(), X)` emits it. The schema is still sent verbatim.
 */
function isNoOpPropertyNames(value: JsonValue | undefined): boolean {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value).filter((key) => !ANNOTATION_KEYWORDS.has(key))
  return keys.length === 1 && keys[0] === 'type' && value['type'] === 'string'
}

function assertNodeProfile(node: JsonObject, path: string, profile: JsonSchemaProfile) {
  const who = describeProvider(profile)
  const allowed = profile.keywords

  for (const keyword of Object.keys(node)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue
    if (allowed.includes(keyword)) continue
    if (keyword === 'propertyNames' && isNoOpPropertyNames(node[keyword])) continue
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
  if (typeof format === 'string' && !profile.formats.includes(format)) {
    throw badSchema(
      `${path}: ${who} enforces \`format\` only for [${profile.formats.join(
        ', ',
      )}]; ${JSON.stringify(format)} would be accepted and ignored. ${
        FORMAT_HINTS[format] ?? 'Remove it and validate host-side.'
      }`,
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
 * First construct in `pattern` that is outside the regex subset the shipped
 * profiles hold patterns to, or `undefined`. Inside a character class only
 * property escapes (`[\p{L}]`) and `\k` are flagged: `[\b]` is a backspace and
 * `[\1]` an octal escape there, and the rest of a class is literal.
 */
function unsupportedPatternConstruct(pattern: string): string | undefined {
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1] ?? ''
      i += 1
      if (next === 'p' || next === 'P') return `a property escape (\\${next})`
      if (next === 'k') return 'a named backreference (\\k)'
      if (inClass) continue
      if (/[1-9]/.test(next)) return `a backreference (\\${next})`
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

/** A `$ref` found while walking, with the nodes it sits inside. */
interface RefSite {
  readonly ref: string
  readonly path: string
  /**
   * The nodes that contain this site for reachability: from the nearest
   * `$defs` / `definitions` entry (or the root) down to the node holding the
   * `$ref`. A definitions map is not part of the schema that owns it, so the
   * chain restarts at every definition.
   */
  readonly within: readonly JsonObject[]
}

function walkProfile(
  value: JsonValue,
  path: string,
  profile: JsonSchemaProfile,
  refs: RefSite[],
  within: readonly JsonObject[],
): void {
  if (!isPlainObject(value)) return
  assertNodeProfile(value, path, profile)
  const chain = [...within, value]
  const ref = value['$ref']
  if (ref !== undefined) {
    if (typeof ref !== 'string') {
      throw badSchema(`${path}: \`$ref\` must be a string.`, profile.provider)
    }
    refs.push({ ref, path, within: chain })
  }
  for (const sub of subschemasOf(value, path)) {
    walkProfile(
      sub.value,
      sub.path,
      profile,
      refs,
      DEFINITION_KEYWORDS.has(sub.keyword) ? [] : chain,
    )
  }
}

/**
 * The schema a local `$ref` points at, or `undefined` when the pointer does
 * not resolve to a schema. Follows schema positions only (`properties/a`,
 * `$defs/X`, `anyOf/0`, `items`), so a pointer into a keyword's data
 * (`#/properties`, `#/enum/0`) does not resolve.
 */
function resolvePointer(root: JsonObject, ref: string): JsonObject | undefined {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: JsonValue = root
  // What the next segment names: a keyword of a schema, an entry of a map of
  // schemas, or an index into an array of schemas.
  let expect: 'keyword' | 'name' | 'index' = 'keyword'
  for (const raw of ref.slice(2).split('/')) {
    let segment = raw
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return undefined
    }
    segment = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (expect === 'index') {
      if (!Array.isArray(current)) return undefined
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index] as JsonValue
      expect = 'keyword'
      continue
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined
    const next: JsonValue = current[segment] as JsonValue
    if (expect === 'name') {
      expect = 'keyword'
    } else if ((SCHEMA_MAP_KEYWORDS as readonly string[]).includes(segment)) {
      expect = 'name'
    } else if ((SCHEMA_ARRAY_KEYWORDS as readonly string[]).includes(segment)) {
      expect = 'index'
    } else if (!(SINGLE_SCHEMA_KEYWORDS as readonly string[]).includes(segment)) {
      return undefined
    }
    current = next
  }
  return expect === 'keyword' && isPlainObject(current) ? current : undefined
}

/** True when the node says nothing but `$ref` (and annotations). */
function isPureAlias(node: JsonObject): boolean {
  return (
    typeof node['$ref'] === 'string' &&
    Object.keys(node).every((key) => key === '$ref' || ANNOTATION_KEYWORDS.has(key))
  )
}

function assertRefs(
  root: JsonObject,
  rootPath: string,
  refs: readonly RefSite[],
  profile: JsonSchemaProfile,
): void {
  const targets = new Map<RefSite, JsonObject>()
  for (const site of refs) {
    if (!site.ref.startsWith('#')) {
      throw badSchema(
        `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} is not a local reference. Only same-document references ("#/$defs/Name" or "#") are accepted.`,
        profile.provider,
      )
    }
    const target = resolvePointer(root, site.ref)
    if (target === undefined) {
      throw badSchema(
        `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} does not resolve to a schema in ${rootPath}.`,
        profile.provider,
      )
    }
    targets.set(site, target)
  }

  // A chain of references that only ever points at another reference never
  // reaches a schema, on any provider.
  for (const site of refs) {
    const seen = new Set<JsonObject>()
    let node = targets.get(site) as JsonObject
    while (isPureAlias(node)) {
      if (seen.has(node)) {
        throw badSchema(
          `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} leads to a loop of references that never reaches a schema.`,
          profile.provider,
        )
      }
      seen.add(node)
      node = resolvePointer(root, node['$ref'] as string) as JsonObject
    }
  }

  if (profile.circularRefs) return

  // site A -> site B when B sits inside the schema A points at. A cycle in
  // that graph is a recursive schema; every site is a start, so a cyclic entry
  // nothing points at is found too.
  const state = new Map<RefSite, 'visiting' | 'done'>()
  const visit = (site: RefSite): void => {
    state.set(site, 'visiting')
    const target = targets.get(site) as JsonObject
    for (const next of refs) {
      if (!next.within.includes(target)) continue
      const status = state.get(next)
      if (status === 'visiting') {
        throw badSchema(
          `${site.path}: \`$ref\` ${JSON.stringify(site.ref)} is circular (a recursive schema). ${describeProvider(
            profile,
          )} supports non-circular references only.`,
          profile.provider,
        )
      }
      if (status === undefined) visit(next)
    }
    state.set(site, 'done')
  }
  for (const site of refs) {
    if (state.get(site) === undefined) visit(site)
  }
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
  walkProfile(schema, path, profile, refs, [])
  assertRefs(schema, path, refs, profile)
}

// ---------------------------------------------------------------------------
// Layer 3: portable subset
// ---------------------------------------------------------------------------

/**
 * The portable subset: the keywords the Gemini 3.x and xAI profiles both
 * enforce (ADR-034 publishes the table; a test in `@gullabs/any-llm` keeps this
 * equal to that intersection over every Gemini 3.x model). Annotations are
 * accepted on top of these.
 *
 * It is not "every provider": Gemma 4 additionally rejects `format`,
 * `minLength` and `maxLength`, `claude-cli` and `codex-cli` run their own
 * checks (or none), and `pattern`, `minLength` and `maxLength` are only
 * probabilistically obeyed on Gemini.
 */
export const PORTABLE_JSON_SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
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
])

/** `format` values enforced by both the Gemini 3.x and xAI profiles. */
export const PORTABLE_JSON_SCHEMA_FORMATS: readonly string[] = Object.freeze([
  'date-time',
  'date',
  'email',
])

const PORTABLE_PROFILE: JsonSchemaProfile = Object.freeze({
  keywords: PORTABLE_JSON_SCHEMA_KEYWORDS,
  formats: PORTABLE_JSON_SCHEMA_FORMATS,
  // The smaller of the profiles' limits (only xAI declares any), for the
  // portable keywords.
  limits: Object.freeze({
    minLength: 2048,
    maxLength: 2048,
    minItems: 256,
    maxItems: 256,
  }),
  circularRefs: false,
  booleanItems: false,
  patternSubset: true,
})

/**
 * Lint a schema against the portable subset, so a schema that routes to Gemini
 * 3.x or xAI is known to use only keywords both profiles enforce. Intended for
 * a host build-time test over every call site; adapters do not call it. It
 * does not cover Gemma's stricter profile or the CLI providers.
 *
 * @param path Label used in messages (default `schema`).
 * @throws {LlmError} `kind: 'bad_request'` naming the offending node's path.
 */
export function assertPortableJsonSchema(schema: JsonValue, path = 'schema'): void {
  assertJsonSchemaProfile(schema, path, PORTABLE_PROFILE)
}
