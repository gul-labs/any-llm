import { z } from 'zod'

import { LlmError } from '../errors.js'
import type { JsonValue } from '../types.js'

export function toConfigJsonSchema(schema: z.ZodType): JsonValue {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'throw' }) as JsonValue
  } catch (err) {
    if (err instanceof LlmError) throw err
    throw new LlmError(
      `A model config schema must be representable as JSON Schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { kind: 'bad_request', retryable: false, cause: err },
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every property name the JSON Schema names at its top level: the `properties`
 * keys of the object itself and of every `anyOf` / `oneOf` / `allOf` branch,
 * recursively, sorted and deduplicated. A local `$ref` into the schema's own
 * `$defs` / `definitions` (what Zod emits for a schema carrying `.meta({ id })`)
 * is followed; one that points anywhere else, or that loops, is refused rather
 * than skipped (a skipped branch would silently drop keys).
 *
 * @internal
 */
export function configKeysOfJsonSchema(schema: JsonValue): string[] {
  const keys = new Set<string>()
  const followed = new Set<string>()
  const refused = (why: string): LlmError =>
    new LlmError(`A model config schema's keys cannot be listed: ${why}.`, {
      kind: 'bad_request',
      retryable: false,
    })
  const resolve = (ref: unknown): unknown => {
    const match =
      typeof ref === 'string' ? /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref) : null
    if (match === null || !isRecord(schema)) {
      throw refused(`$ref ${String(ref)} is not a local reference into $defs`)
    }
    const container = schema[match[1] as string]
    const name = (match[2] as string).replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(container) || !(name in container)) {
      throw refused(`$ref ${String(ref)} does not resolve`)
    }
    return container[name]
  }
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return
    if ('$ref' in node) {
      const ref = String(node['$ref'])
      // A reference already being followed is a loop: its keys are collected.
      if (followed.has(ref)) return
      followed.add(ref)
      visit(resolve(node['$ref']))
      followed.delete(ref)
    }
    if (isRecord(node['properties'])) {
      for (const key of Object.keys(node['properties'])) keys.add(key)
    }
    for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[combinator]
      if (Array.isArray(branches)) branches.forEach(visit)
    }
  }
  visit(schema)
  return [...keys].sort()
}

/**
 * The top-level config keys a model's schema names (see
 * `ModelDescriptor.configKeys`): the keys of each object shape across the
 * branches of a union, sorted. Derived from the same JSON Schema as
 * `configJsonSchema`, so the two cannot disagree.
 */
export function toConfigKeys(schema: z.ZodType): readonly string[] {
  return configKeysOfJsonSchema(toConfigJsonSchema(schema))
}
