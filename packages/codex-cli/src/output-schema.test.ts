/**
 * output-schema.test.ts — shared-walker completeness, D1 preflight, and D2
 * rewrite-helper tests for `@gullabs/codex-cli`.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import {
  OUTPUT_SCHEMA_WALK_KEYWORDS,
  assertOpenAiStrictOutputSchema,
  toOpenAiStrictOutputSchema,
  walkOutputSchemaNodes,
} from './output-schema.js'

// ---------------------------------------------------------------------------
// Deep-freeze helper (purity checks)
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function expectBadRequest(fn: () => void): LlmError {
  try {
    fn()
    expect.unreachable('should have thrown')
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError)
    expect((e as LlmError).kind).toBe('bad_request')
    expect((e as LlmError).retryable).toBe(false)
    return e as LlmError
  }
  throw new Error('unreachable')
}

// ---------------------------------------------------------------------------
// 1. Pinned traversal-set completeness
// ---------------------------------------------------------------------------

describe('OUTPUT_SCHEMA_WALK_KEYWORDS — pinned traversal-set completeness', () => {
  it('is a superset of the COMPLETE draft-2020-12 applicator + content vocabulary subschema keywords, plus $defs/definitions', () => {
    // Pinned literal list, transcribed independently from
    // docs/archive/openai-strict-output-schema-plan.md §D1 — NOT imported from the
    // module under test, so this fails CI if the walker's own keyword set
    // ever narrows.
    const PINNED_REQUIRED_KEYWORDS = [
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
    ]

    const walkerKeywords = new Set<string>(OUTPUT_SCHEMA_WALK_KEYWORDS)
    for (const keyword of PINNED_REQUIRED_KEYWORDS) {
      expect(walkerKeywords.has(keyword)).toBe(true)
    }
  })

  it('walkOutputSchemaNodes actually recurses into every enumerated position', () => {
    // A schema exercising every pinned position at once, each nested schema
    // carrying a distinctive marker property so we can assert every marker
    // was visited (not just that the schema "looks" traversable).
    const marker = (name: string): JsonValue => ({ __marker: name })

    const schema: JsonValue = {
      properties: { p: marker('properties') },
      patternProperties: { '^x-': marker('patternProperties') },
      additionalProperties: marker('additionalProperties'),
      items: marker('items-single'),
      prefixItems: [marker('prefixItems0')],
      contains: marker('contains'),
      anyOf: [marker('anyOf0')],
      oneOf: [marker('oneOf0')],
      allOf: [marker('allOf0')],
      not: marker('not'),
      if: marker('if'),
      then: marker('then'),
      else: marker('else'),
      dependentSchemas: { d: marker('dependentSchemas') },
      propertyNames: marker('propertyNames'),
      unevaluatedProperties: marker('unevaluatedProperties'),
      unevaluatedItems: marker('unevaluatedItems'),
      contentSchema: marker('contentSchema'),
      $defs: { D: marker('$defs') },
      definitions: { D: marker('definitions') },
    }

    const visitedMarkers = new Set<string>()
    walkOutputSchemaNodes(schema, '', (node) => {
      const m = (node as Record<string, JsonValue>).__marker
      if (typeof m === 'string') visitedMarkers.add(m)
    })

    for (const expected of [
      'properties',
      'patternProperties',
      'additionalProperties',
      'items-single',
      'prefixItems0',
      'contains',
      'anyOf0',
      'oneOf0',
      'allOf0',
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
    ]) {
      expect(visitedMarkers.has(expected)).toBe(true)
    }
  })

  it('walkOutputSchemaNodes recurses into tuple-form `items` (array of schemas)', () => {
    const visited: string[] = []
    walkOutputSchemaNodes(
      { items: [{ type: 'string' }, { type: 'number' }] },
      '',
      (_node, path) => visited.push(path),
    )
    expect(visited).toContain('items[0]')
    expect(visited).toContain('items[1]')
  })
})

// ---------------------------------------------------------------------------
// 2. D1 — assertOpenAiStrictOutputSchema
// ---------------------------------------------------------------------------

describe('assertOpenAiStrictOutputSchema — positives', () => {
  it('passes a strict-valid schema with $defs, anyOf, and nullable types', () => {
    const schema: JsonValue = {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'tag'],
      properties: {
        name: { type: 'string' },
        tag: {
          anyOf: [{ $ref: '#/$defs/Tag' }, { type: 'null' }],
        },
      },
      $defs: {
        Tag: {
          type: 'object',
          additionalProperties: false,
          required: ['label'],
          properties: { label: { type: ['string', 'null'] } },
        },
      },
    }
    expect(() => assertOpenAiStrictOutputSchema(schema)).not.toThrow()
  })

  it('leaves a non-object root schema unaffected', () => {
    expect(() => assertOpenAiStrictOutputSchema({ type: 'string' })).not.toThrow()
  })

  it('does not require `required` when `properties` is empty', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }
    expect(() => assertOpenAiStrictOutputSchema(schema)).not.toThrow()
  })
})

describe('assertOpenAiStrictOutputSchema — rule 1 (additionalProperties: false)', () => {
  it('rejects a root object missing additionalProperties: false', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
      }),
    )
    expect(err.message).toContain('<root>')
  })

  it('rejects additionalProperties: true at the root', () => {
    expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: true,
        properties: { a: { type: 'string' } },
        required: ['a'],
      }),
    )
  })

  it('rejects a nested object missing additionalProperties: false, path-correct', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        required: ['nested'],
        properties: {
          nested: {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
        },
      }),
    )
    expect(err.message).toContain('properties.nested')
  })

  it('catches a violation inside prefixItems (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        required: ['tuple'],
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
            ],
          },
        },
      }),
    )
    expect(err.message).toContain('properties.tuple.prefixItems[0]')
  })

  it('catches a violation inside patternProperties (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '^x-': {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
          },
        },
      }),
    )
    expect(err.message).toContain('patternProperties.^x-')
  })

  it('catches a violation inside if/then/else (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        if: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      }),
    )
    expect(err.message).toContain('if')
  })

  it('catches a violation inside a schema-valued additionalProperties (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
      }),
    )
    expect(err.message).toContain('additionalProperties')
  })
})

describe('assertOpenAiStrictOutputSchema — rule 2 (required covers properties)', () => {
  it('rejects a root object missing a property from required, naming the first missing key', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      }),
    )
    expect(err.message).toContain('<root>')
    expect(err.message).toContain("'b'")
    expect(err.message).toContain('toOpenAiStrictOutputSchema')
  })

  it('rejects a root object with `required` entirely absent', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
      }),
    )
    expect(err.message).toContain("'a'")
  })

  it('rejects a malformed (non-array) required', () => {
    expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
        required: 'a',
      }),
    )
  })

  it('rejects a malformed (non-string-array) required', () => {
    expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string' } },
        required: [1, 2],
      }),
    )
  })

  it('rejects a nested rule-2 violation, path-correct, at nested depth', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        required: ['nested'],
        properties: {
          nested: {
            type: 'object',
            additionalProperties: false,
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            required: ['a'],
          },
        },
      }),
    )
    expect(err.message).toContain('properties.nested')
    expect(err.message).toContain("'b'")
  })

  it('catches a rule-2 violation inside prefixItems (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        required: ['tuple'],
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              {
                type: 'object',
                additionalProperties: false,
                properties: { x: { type: 'string' } },
              },
            ],
          },
        },
      }),
    )
    expect(err.message).toContain('prefixItems[0]')
    expect(err.message).toContain("'x'")
  })

  it('catches a rule-2 violation inside patternProperties (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        patternProperties: {
          '^x-': {
            type: 'object',
            additionalProperties: false,
            properties: { a: { type: 'string' } },
          },
        },
      }),
    )
    expect(err.message).toContain('patternProperties.^x-')
  })

  it('catches a rule-2 violation inside if/then/else (a newly-covered position)', () => {
    const err = expectBadRequest(() =>
      assertOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: false,
        then: {
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'string' } },
        },
      }),
    )
    expect(err.message).toContain('then')
  })
})

// ---------------------------------------------------------------------------
// 3. D2 — toOpenAiStrictOutputSchema
// ---------------------------------------------------------------------------

describe('toOpenAiStrictOutputSchema', () => {
  it('injects additionalProperties: false when absent', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
    }) as Record<string, JsonValue>
    expect(result.additionalProperties).toBe(false)
  })

  it('leaves additionalProperties: false untouched', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string' } },
    }) as Record<string, JsonValue>
    expect(result.additionalProperties).toBe(false)
  })

  it('rejects explicit additionalProperties: true', () => {
    expectBadRequest(() =>
      toOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: true,
        properties: { a: { type: 'string' } },
      }),
    )
  })

  it('rejects a schema-valued additionalProperties', () => {
    expectBadRequest(() =>
      toOpenAiStrictOutputSchema({
        type: 'object',
        additionalProperties: { type: 'string' },
        properties: { a: { type: 'string' } },
      }),
    )
  })

  it('treats an absent `required` as the empty list and remediates every property', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    }) as Record<string, JsonValue>
    expect(result.required).toEqual(['a', 'b'])
  })

  it('rejects a malformed (non-array) required', () => {
    expectBadRequest(() =>
      toOpenAiStrictOutputSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: 'a',
      }),
    )
  })

  it('rejects a malformed (non-string-array) required', () => {
    expectBadRequest(() =>
      toOpenAiStrictOutputSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [1],
      }),
    )
  })

  it('widens a typed optional property to a nullable union: type: T -> type: [T, "null"]', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: [],
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ type: ['string', 'null'] })
    expect(result.required).toEqual(['a'])
  })

  it('leaves an already-nullable typed property untouched', () => {
    const original = { type: ['string', 'null'] }
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: original },
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ type: ['string', 'null'] })
  })

  it('leaves a single `type: "null"` property untouched (degenerate already-nullable case)', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: 'null' } },
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ type: 'null' })
  })

  it('wraps a boolean-schema (`true`) optional property defensively as anyOf', () => {
    const schema: JsonValue = { type: 'object', properties: { a: true } }
    const result = toOpenAiStrictOutputSchema(schema) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ anyOf: [true, { type: 'null' }] })
  })

  it('appends "null" to a multi-type array that does not already include it', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: ['string', 'number'] } },
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ type: ['string', 'number', 'null'] })
  })

  it('wraps a no-type optional property as anyOf: [<original>, {type: "null"}]', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({
      anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }],
    })
  })

  it('leaves a property already listed in required unmodified', () => {
    const result = toOpenAiStrictOutputSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }) as Record<string, JsonValue>
    const props = result.properties as Record<string, JsonValue>
    expect(props.a).toEqual({ type: 'string' })
    expect(result.required).toEqual(['a'])
  })

  it('is idempotent: f(f(x)) deep-equals f(x)', () => {
    const input: JsonValue = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { anyOf: [{ type: 'number' }] },
        nested: {
          type: 'object',
          properties: { c: { type: 'boolean' } },
          required: ['c'],
        },
      },
      required: ['nested'],
    }
    const once = toOpenAiStrictOutputSchema(input)
    const twice = toOpenAiStrictOutputSchema(once)
    expect(twice).toEqual(once)
  })

  it('never mutates the input (deep-frozen input survives unchanged)', () => {
    const input = deepFreeze({
      type: 'object',
      properties: {
        a: { type: 'string' },
        nested: {
          type: 'object',
          properties: { b: { type: 'number' } },
        },
      },
    }) as JsonValue
    const snapshot = JSON.parse(JSON.stringify(input)) as JsonValue

    expect(() => toOpenAiStrictOutputSchema(input)).not.toThrow()
    expect(input).toEqual(snapshot)
  })

  it('deep-clones: the result shares no object references with the input', () => {
    const input: JsonValue = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    }
    const result = toOpenAiStrictOutputSchema(input) as Record<string, JsonValue>
    expect(result).not.toBe(input)
    expect(result.properties).not.toBe((input as Record<string, JsonValue>).properties)
  })

  it('end-to-end: a gnarly fixture (nested objects + $defs + anyOf + optional props) passes the preflight', () => {
    const gnarly: JsonValue = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        tag: { $ref: '#/$defs/Tag' },
        variants: {
          type: 'array',
          items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/Tag' }] },
        },
      },
      required: ['title'],
      $defs: {
        Tag: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            weight: { type: 'number' },
          },
          required: ['label'],
        },
      },
    }

    const rewritten = toOpenAiStrictOutputSchema(gnarly)
    expect(() => assertOpenAiStrictOutputSchema(rewritten)).not.toThrow()
  })
})
