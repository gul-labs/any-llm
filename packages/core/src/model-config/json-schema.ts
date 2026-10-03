import { z } from 'zod'

import { LlmError } from '../errors.js'
import type { JsonValue } from '../types.js'

export function toConfigJsonSchema(schema: z.ZodType): JsonValue {
  return z.toJSONSchema(schema, { unrepresentable: 'throw' }) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every property name the JSON Schema names at its top level: the `properties`
 * keys of the object itself and of every `anyOf` / `oneOf` / `allOf` branch,
 * recursively, sorted and deduplicated. A `$ref` cannot be followed here, so it
 * is refused rather than skipped (a skipped branch would silently drop keys).
 *
 * @internal
 */
export function configKeysOfJsonSchema(schema: JsonValue): string[] {
  const keys = new Set<string>()
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return
    if ('$ref' in node) {
      throw new LlmError(
        'A model config schema may not use $ref at its top level: its keys cannot be listed.',
        { kind: 'bad_request', retryable: false },
      )
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
