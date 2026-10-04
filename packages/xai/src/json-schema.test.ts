import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertJsonSchemaProfile,
  LlmError,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
} from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { XAI_JSON_SCHEMA_PROFILE } from './json-schema.js'

const docs = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './__fixtures__/structured-output-schema-docs-2026-10-03.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as {
  supportedTypesAndKeywords: string[]
  references: string
  pattern: { supported: string; notSupported: string[] }
  rejectedWith400: string[]
  formatsEnforced: string[]
  constraintLimits: Record<string, unknown>
}
const zodPinned = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../core/src/__fixtures__/zod-4.6.5-json-schemas.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  cases: Array<{
    name: string
    schema: JsonValue
    verdicts: { xai: { verdict: string; reason?: string } }
  }>
}

function check(schema: JsonValue, path = 'output.jsonSchema'): void {
  assertJsonSchemaProfile(schema, path, XAI_JSON_SCHEMA_PROFILE)
}
function rejection(schema: JsonValue, path = 'output.jsonSchema'): LlmError {
  try {
    check(schema, path)
  } catch (err) {
    if (err instanceof LlmError) return err
    throw err
  }
  throw new Error('expected rejection')
}

describe('xAI JSON Schema profile (docs read 2026-10-03)', () => {
  it('enforces exactly the keywords the docs fixture names, plus the structural ones it implies', () => {
    // Keywords the fixture names as such. `type` stands for the listed type names.
    const documented = new Set<string>([
      'type',
      ...docs.supportedTypesAndKeywords.filter((name) =>
        ['enum', 'const', 'anyOf'].includes(name),
      ),
      '$ref',
      '$defs',
      'additionalProperties',
      'format',
      'pattern',
      ...Object.keys(docs.constraintLimits)
        .filter((key) => key !== 'aboveTheLimit')
        .flatMap((key) => key.split('/')),
    ])
    expect(docs.references).toContain('$ref / $defs')
    expect(docs.pattern.supported).toContain('regular expressions')
    expect(docs.formatsEnforced.length).toBeGreaterThan(0)
    // Not listed as keywords in the fixture; implied by the listed `object` and
    // `array` types and named in its 400 list (`properties`, `prefixItems`). The
    // fixture says nothing about `required` and `items`, so these four rest on the
    // types, not on a documented keyword.
    const implied = ['properties', 'required', 'items', 'prefixItems']
    expect(docs.rejectedWith400.join(' ')).toContain('properties')
    expect(docs.rejectedWith400.join(' ')).toContain('prefixItems')
    expect([...XAI_JSON_SCHEMA_PROFILE.keywords].sort()).toEqual(
      [...documented, ...implied].sort(),
    )
  })

  it('declares the documented format set and limits', () => {
    expect([...XAI_JSON_SCHEMA_PROFILE.formats]).toEqual(docs.formatsEnforced)
    expect(XAI_JSON_SCHEMA_PROFILE.limits).toEqual({
      minLength: docs.constraintLimits['minLength/maxLength'],
      maxLength: docs.constraintLimits['minLength/maxLength'],
      minItems: docs.constraintLimits['minItems/maxItems'],
      maxItems: docs.constraintLimits['minItems/maxItems'],
      minProperties: docs.constraintLimits['minProperties/maxProperties'],
      maxProperties: docs.constraintLimits['minProperties/maxProperties'],
    })
  })

  it('is a superset of the portable subset, and rejects recursion', () => {
    for (const keyword of PORTABLE_JSON_SCHEMA_KEYWORDS) {
      expect(XAI_JSON_SCHEMA_PROFILE.keywords).toContain(keyword)
    }
    expect(XAI_JSON_SCHEMA_PROFILE.circularRefs).toBe(false)
  })

  it.each([
    ['oneOf (read as anyOf)', { oneOf: [{ type: 'string' }, { type: 'number' }] }],
    ['allOf (single subschema only; rejected outright)', { allOf: [{ type: 'string' }] }],
    ['not (best effort)', { not: { type: 'string' } }],
    ['if/then/else (best effort)', { if: { type: 'string' }, then: {}, else: {} }],
    ['an unlisted format', { type: 'string', format: 'hostname' }],
    ['maxLength above the limit', { type: 'string', maxLength: 2049 }],
    ['maxItems above the limit', { type: 'array', maxItems: 257 }],
    ['maxProperties above the limit', { type: 'object', maxProperties: 65 }],
    ['minContains', { type: 'array', minContains: 1 }],
    ['items as an array', { type: 'array', items: [{ type: 'string' }] }],
    ['a boolean property schema', { type: 'object', properties: { a: true } }],
    ['an empty anyOf', { anyOf: [] }],
    ['an empty enum', { enum: [] }],
    ['multipleOf (undocumented)', { type: 'number', multipleOf: 2 }],
    ['uniqueItems (undocumented)', { type: 'array', uniqueItems: true }],
    ['a recursive $ref', { type: 'object', properties: { k: { $ref: '#' } } }],
    ['a lookahead pattern', { type: 'string', pattern: '^(?=a)' }],
    [
      'a property escape in a character class',
      { type: 'string', pattern: '^[\\p{L}]+$' },
    ],
    [
      'a property escape with a class sibling',
      { type: 'string', pattern: '^[\\p{L}\\s]+$' },
    ],
    ['a closed tuple (items: false, undocumented)', { type: 'array', items: false }],
  ])('rejects %s', (_name, schema) => {
    const err = rejection(schema as JsonValue)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false, provider: 'xai' })
    expect(err.message).toContain('output.jsonSchema')
  })

  it('accepts what the docs enforce, with annotations and limits at the boundary', () => {
    expect(() =>
      check({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Invoice',
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'id' },
          at: { type: 'string', format: 'date-time' },
          ip: { type: 'string', format: 'ipv6' },
          kind: { const: 'invoice' },
          state: { type: 'string', enum: ['open', 'paid'] },
          note: { type: ['string', 'null'], minLength: 0, maxLength: 2048 },
          lines: {
            type: 'array',
            items: { $ref: '#/$defs/Line' },
            minItems: 0,
            maxItems: 256,
          },
          pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] },
          total: { type: 'number', minimum: 0, exclusiveMaximum: 1e9 },
          code: { type: 'string', pattern: '^[A-Z]{3}-\\d{4}$' },
          extra: {
            type: 'object',
            additionalProperties: { type: 'string' },
            maxProperties: 64,
          },
        },
        required: ['id'],
        additionalProperties: false,
        $defs: { Line: { type: 'object', properties: { sku: { type: 'string' } } } },
      }),
    ).not.toThrow()
  })

  it('accepts non-circular $ref/$defs, which the docs support', () => {
    expect(() =>
      check({
        type: 'object',
        properties: { a: { $ref: '#/$defs/A' }, b: { $ref: '#/$defs/A' } },
        $defs: { A: { type: 'object', properties: { n: { type: 'string' } } } },
      }),
    ).not.toThrow()
  })

  it('rejects the OpenAPI dialect with the offending path (nullable, uppercase type)', () => {
    const nullable = rejection(
      { type: 'object', properties: { a: { type: 'string', nullable: true } } },
      'tools[2].inputJsonSchema',
    )
    expect(nullable.message).toContain('tools[2].inputJsonSchema.properties.a')
    expect(nullable.message).toContain("type: ['string', 'null']")
    expect(rejection({ type: 'OBJECT' }).message).toContain('"OBJECT"')
  })

  describe('pinned Zod output', () => {
    it.each(zodPinned.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      for (const path of ['output.jsonSchema', 'tools[0].inputJsonSchema']) {
        const expected = c.verdicts.xai
        if (expected.verdict === 'accept') {
          expect(() => check(c.schema, path)).not.toThrow()
        } else {
          const err = rejection(c.schema, path)
          expect(err.message).toContain(path)
          expect(err.message).toContain(expected.reason ?? '')
        }
      }
    })
  })
})
