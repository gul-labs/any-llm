import { describe, it, expect } from 'vitest'
import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'
import {
  assertJsonSchemaProfile,
  assertPortableJsonSchema,
  assertStandardJsonSchema,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
} from './json-schema.js'
import type { JsonSchemaProfile } from './json-schema.js'

function rejection(run: () => void): LlmError {
  try {
    run()
  } catch (err) {
    if (err instanceof LlmError) return err
    throw err
  }
  throw new Error('expected the assertion to throw')
}

const standard = (schema: JsonValue, path = 'output.jsonSchema'): LlmError =>
  rejection(() => assertStandardJsonSchema(schema, path, { provider: 'acme' }))

describe('assertStandardJsonSchema', () => {
  it('rejects a nullable keyword and names the nested path', () => {
    const err = standard({
      type: 'object',
      properties: {
        company: {
          type: 'object',
          properties: {
            offices: {
              type: 'array',
              items: {
                type: 'object',
                properties: { city: { type: 'string', nullable: true } },
              },
            },
          },
        },
      },
    })
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect(err.provider).toBe('acme')
    expect(err.message).toContain(
      'output.jsonSchema.properties.company.properties.offices.items.properties.city',
    )
    expect(err.message).toContain("type: ['string', 'null']")
  })

  it('names the root when the root is the offender, and carries no provider by default', () => {
    const err = rejection(() =>
      assertStandardJsonSchema(
        { type: 'string', nullable: false },
        'tools[1].inputJsonSchema',
      ),
    )
    expect(err.message).toContain('tools[1].inputJsonSchema')
    expect(err.provider).toBeUndefined()
  })

  it('rejects an uppercase Gemini type name with its path', () => {
    const err = standard({ type: 'object', properties: { name: { type: 'STRING' } } })
    expect(err.message).toContain('"STRING"')
    expect(err.message).toContain('output.jsonSchema.properties.name')
  })

  it('rejects an uppercase root type, an uppercase type-array member and a non-string member', () => {
    expect(standard({ type: 'OBJECT' }).message).toContain('"OBJECT"')
    expect(
      standard({ type: 'object', properties: { n: { type: ['INTEGER', 'null'] } } })
        .message,
    ).toContain('"INTEGER"')
    expect(standard({ type: [1] as never }).message).toContain('1')
  })

  it('rejects boolean subschemas, but not additionalProperties or items booleans', () => {
    expect(standard({ type: 'object', properties: { a: true } }).message).toContain(
      'output.jsonSchema.properties.a',
    )
    expect(standard({ anyOf: [false, { type: 'string' }] }).message).toContain('anyOf[0]')
    expect(standard({ not: true }).message).toContain('output.jsonSchema.not')
    expect(standard({ $defs: { X: false } }).message).toContain('$defs.X')
    expect(() =>
      assertStandardJsonSchema(
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            t: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
          },
        },
        'x',
      ),
    ).not.toThrow()
  })

  it('rejects the draft-07 array form of items', () => {
    const err = standard({ items: [{ type: 'string' }] })
    expect(err.message).toContain('prefixItems')
    expect(err.message).toContain('output.jsonSchema.items')
  })

  it.each([
    ['anyOf', { anyOf: [{ type: 'string' }, { type: 'NULL' }] }, 'anyOf[1]'],
    ['oneOf', { oneOf: [{ type: 'string', nullable: true }] }, 'oneOf[0]'],
    ['allOf', { allOf: [{ type: 'OBJECT' }] }, 'allOf[0]'],
    ['$defs', { $defs: { Leader: { type: 'OBJECT' } } }, '$defs.Leader'],
    [
      'definitions',
      { definitions: { Leader: { nullable: true } } },
      'definitions.Leader',
    ],
    ['prefixItems', { prefixItems: [{ type: 'STRING' }] }, 'prefixItems[0]'],
    [
      'additionalProperties',
      { additionalProperties: { type: 'STRING' } },
      'additionalProperties',
    ],
    [
      'patternProperties',
      { patternProperties: { '^x': { nullable: true } } },
      'patternProperties.^x',
    ],
    ['not', { not: { type: 'STRING' } }, 'not'],
    ['if/then/else', { if: {}, then: {}, else: { type: 'ARRAY' } }, 'else'],
    ['contains', { contains: { type: 'BOOLEAN' } }, 'contains'],
    [
      'dependentSchemas',
      { dependentSchemas: { a: { nullable: true } } },
      'dependentSchemas.a',
    ],
    ['propertyNames', { propertyNames: { type: 'STRING' } }, 'propertyNames'],
    [
      'unevaluatedProperties',
      { unevaluatedProperties: { type: 'STRING' } },
      'unevaluatedProperties',
    ],
    ['unevaluatedItems', { unevaluatedItems: { type: 'STRING' } }, 'unevaluatedItems'],
    ['contentSchema', { contentSchema: { type: 'STRING' } }, 'contentSchema'],
    ['additionalItems', { additionalItems: { type: 'STRING' } }, 'additionalItems'],
    [
      'dependencies (schema form)',
      { dependencies: { a: { nullable: true }, b: ['c'] } },
      'dependencies.a',
    ],
  ])('walks %s', (_name, schema, path) => {
    expect(standard(schema as JsonValue).message).toContain(path)
  })

  it('accepts standard JSON Schema, annotations and null unions, and never mutates', () => {
    const schema: JsonValue = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:x',
      $comment: 'c',
      title: 'T',
      description: 'd',
      type: 'object',
      properties: {
        name: { type: 'string', default: 'x', examples: ['y'], deprecated: true },
        employees: { type: ['integer', 'null'], readOnly: true, writeOnly: false },
        founded: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        leader: { $ref: '#/$defs/Leader' },
      },
      required: ['name'],
      $defs: { Leader: { type: 'object', properties: { name: { type: 'string' } } } },
    }
    const before = JSON.stringify(schema)
    expect(() => assertStandardJsonSchema(schema, 'x')).not.toThrow()
    expect(JSON.stringify(schema)).toBe(before)
  })

  it('accepts properties named nullable or type and dialect words in data positions', () => {
    expect(() =>
      assertStandardJsonSchema(
        {
          type: 'object',
          description: 'nullable: true, type STRING',
          properties: {
            nullable: { type: 'boolean' },
            type: { type: 'string', enum: ['STRING', 'OBJECT'] },
            kind: { const: 'STRING' },
            label: { type: 'string', enum: ['OBJECT', 'nullable'], default: 'OBJECT' },
            sample: { type: 'object', examples: [{ type: 'STRING', nullable: true }] },
          },
          required: ['nullable', 'type'],
          dependencies: { a: ['b'] },
        },
        'x',
      ),
    ).not.toThrow()
  })

  it('ignores a non-object schema value (the engine owns that check)', () => {
    expect(() => assertStandardJsonSchema(true, 'x')).not.toThrow()
    expect(() => assertStandardJsonSchema('x', 'x')).not.toThrow()
  })
})

const PROFILE: JsonSchemaProfile = {
  provider: 'acme',
  keywords: [
    'type',
    'properties',
    'required',
    'enum',
    'items',
    'format',
    'pattern',
    '$ref',
    '$defs',
    'minLength',
    'minItems',
    'anyOf',
    'additionalProperties',
  ],
  formats: ['date', 'email'],
  limits: { minLength: 10, minItems: 5 },
  circularRefs: false,
  booleanItems: false,
  patternSubset: true,
}
const profiled = (schema: JsonValue): LlmError =>
  rejection(() => assertJsonSchemaProfile(schema, 'output.jsonSchema', PROFILE))

describe('assertJsonSchemaProfile', () => {
  it('runs the dialect check first', () => {
    expect(profiled({ type: 'STRING' }).message).toContain('"STRING"')
  })

  it('rejects a keyword outside the set with its path, provider and a hint', () => {
    const err = profiled({
      type: 'object',
      properties: { kind: { type: 'string', const: 'x' } },
    })
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false, provider: 'acme' })
    expect(err.message).toContain('output.jsonSchema.properties.kind')
    expect(err.message).toContain('`const`')
    expect(err.message).toContain("z.enum(['x'])")
  })

  it.each([
    ['oneOf', { oneOf: [{ type: 'string' }] }, 'anyOf'],
    ['allOf', { allOf: [{ type: 'string' }] }, 'Merge'],
    ['multipleOf', { type: 'number', multipleOf: 2 }, 'host-side'],
    ['uniqueItems', { type: 'array', uniqueItems: true }, 'host-side'],
    ['propertyNames', { type: 'object', propertyNames: { type: 'string' } }, 'z.record'],
    ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }, '`minimum`'],
    ['an unknown vendor keyword', { 'x-vendor': 1 }, 'host-side'],
  ])('rejects %s', (_name, schema, hint) => {
    const err = profiled(schema as JsonValue)
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain(hint)
  })

  it('accepts every annotation on top of the set', () => {
    expect(() =>
      assertJsonSchemaProfile(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'a',
          $comment: 'b',
          title: 't',
          description: 'd',
          examples: [1],
          default: {},
          deprecated: false,
          readOnly: true,
          writeOnly: false,
          type: 'object',
        },
        'x',
        PROFILE,
      ),
    ).not.toThrow()
  })

  it('does not inspect data positions', () => {
    expect(() =>
      assertJsonSchemaProfile(
        {
          type: 'object',
          properties: {
            const: { type: 'string', enum: ['const', 'oneOf'], default: { allOf: 1 } },
            oneOf: { type: 'string', examples: [{ uniqueItems: true }] },
          },
        },
        'x',
        PROFILE,
      ),
    ).not.toThrow()
  })

  it('enforces the format value set', () => {
    expect(() =>
      assertJsonSchemaProfile({ type: 'string', format: 'email' }, 'x', PROFILE),
    ).not.toThrow()
    const err = profiled({
      type: 'object',
      properties: { u: { type: 'string', format: 'uuid' } },
    })
    expect(err.message).toContain('"uuid"')
    expect(err.message).toContain('output.jsonSchema.properties.u')
  })

  it('rejects a limit above the enforced maximum and accepts one at it', () => {
    expect(() =>
      assertJsonSchemaProfile({ type: 'string', minLength: 10 }, 'x', PROFILE),
    ).not.toThrow()
    expect(profiled({ type: 'string', minLength: 11 }).message).toContain('up to 10')
    expect(profiled({ type: 'array', minItems: 6 }).message).toContain('`minItems`')
  })

  it('accepts only one-type-plus-null type arrays', () => {
    expect(() =>
      assertJsonSchemaProfile({ type: ['string', 'null'] }, 'x', PROFILE),
    ).not.toThrow()
    expect(profiled({ type: ['string', 'number'] }).message).toContain('anyOf')
    expect(profiled({ type: ['string', 'number', 'null'] }).message).toContain('anyOf')
  })

  it('rejects empty enum and anyOf', () => {
    expect(profiled({ enum: [] }).message).toContain('at least one')
    expect(profiled({ anyOf: [] }).message).toContain('at least one')
  })

  it('rejects items: false unless the profile enforces closed tuples', () => {
    expect(profiled({ items: false }).message).toContain('closed tuple')
    expect(() =>
      assertJsonSchemaProfile({ items: false }, 'x', { ...PROFILE, booleanItems: true }),
    ).not.toThrow()
  })

  it.each([
    ['a lookahead', '^(?=a)b$'],
    ['a lookahead', '^(?!a)b$'],
    ['a lookbehind', '(?<=a)b'],
    ['a backreference', '(a)\\1'],
    ['a named backreference', '(?<n>a)\\k<n>'],
    ['a property escape', '\\p{L}+'],
    ['a word boundary', '\\bfoo'],
    ['an inline modifier', '(?i)abc'],
  ])('rejects a pattern with %s', (construct, pattern) => {
    expect(profiled({ type: 'string', pattern }).message).toContain(construct)
  })

  it('accepts the regex subset: classes, groups, ranges, escaped parens, class contents', () => {
    for (const pattern of [
      '^[a-z]+$',
      '^(?:ab|cd){2,3}$',
      '^\\d{3}-\\w+\\s?$',
      '[\\b]',
      '[(?=]',
      '\\(\\?=x\\)',
      '(?<year>\\d{4})',
    ]) {
      expect(() =>
        assertJsonSchemaProfile({ type: 'string', pattern }, 'x', PROFILE),
      ).not.toThrow()
    }
  })

  describe('$ref', () => {
    it('accepts local references that resolve, including $defs and JSON-pointer escapes', () => {
      expect(() =>
        assertJsonSchemaProfile(
          {
            type: 'object',
            properties: {
              a: { $ref: '#/$defs/Leader' },
              b: { $ref: '#/$defs/a~1b' },
              c: { $ref: '#/properties/d' },
              d: { type: 'string' },
            },
            $defs: { Leader: { type: 'string' }, 'a/b': { type: 'integer' } },
          },
          'x',
          PROFILE,
        ),
      ).not.toThrow()
    })

    it('rejects an external reference and a dangling pointer', () => {
      expect(
        profiled({ properties: { a: { $ref: 'https://example.com/s.json' } } }).message,
      ).toContain('not a local reference')
      const dangling = profiled({
        type: 'object',
        properties: { a: { $ref: '#/$defs/Missing' } },
      })
      expect(dangling.message).toContain('does not resolve')
      expect(dangling.message).toContain('output.jsonSchema.properties.a')
    })

    it('rejects a non-string $ref', () => {
      expect(profiled({ $ref: 1 as never }).message).toContain('must be a string')
    })

    it('rejects a root self-reference and a def cycle when circular refs are unsupported', () => {
      const root = profiled({
        type: 'object',
        properties: { kids: { type: 'array', items: { $ref: '#' } } },
      })
      expect(root.message).toContain('circular')
      const cycle = profiled({
        type: 'object',
        properties: { n: { $ref: '#/$defs/Node' } },
        $defs: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/$defs/Other' } },
          },
          Other: { type: 'object', properties: { back: { $ref: '#/$defs/Node' } } },
        },
      })
      expect(cycle.message).toContain('circular')
    })

    it('accepts a diamond of references (shared, not circular)', () => {
      expect(() =>
        assertJsonSchemaProfile(
          {
            type: 'object',
            properties: { a: { $ref: '#/$defs/A' }, b: { $ref: '#/$defs/B' } },
            $defs: {
              A: { type: 'object', properties: { c: { $ref: '#/$defs/C' } } },
              B: { type: 'object', properties: { c: { $ref: '#/$defs/C' } } },
              C: { type: 'string' },
            },
          },
          'x',
          PROFILE,
        ),
      ).not.toThrow()
    })

    it('accepts recursion when the profile supports circular references', () => {
      const recursive: JsonValue = {
        type: 'object',
        properties: { kids: { type: 'array', items: { $ref: '#' } } },
      }
      expect(() =>
        assertJsonSchemaProfile(recursive, 'x', { ...PROFILE, circularRefs: true }),
      ).not.toThrow()
    })
  })

  it('never mutates the schema', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: { a: { type: 'string', format: 'email' } },
      $defs: { X: { type: 'string' } },
    }
    const before = JSON.stringify(schema)
    assertJsonSchemaProfile(schema, 'x', PROFILE)
    expect(JSON.stringify(schema)).toBe(before)
  })
})

describe('portable subset', () => {
  it('exports the keyword list, annotations excluded', () => {
    expect(PORTABLE_JSON_SCHEMA_KEYWORDS).toContain('anyOf')
    expect(PORTABLE_JSON_SCHEMA_KEYWORDS).toContain('$ref')
    expect(PORTABLE_JSON_SCHEMA_KEYWORDS).not.toContain('const')
    expect(PORTABLE_JSON_SCHEMA_KEYWORDS).not.toContain('oneOf')
    expect(PORTABLE_JSON_SCHEMA_KEYWORDS).not.toContain('title')
  })

  it('accepts a schema inside the subset with annotations', () => {
    expect(() =>
      assertPortableJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        title: 'Report',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80, description: 'n' },
          when: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 5 },
          score: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          kind: { type: 'string', enum: ['a', 'b'] },
          shape: { anyOf: [{ $ref: '#/$defs/Circle' }, { type: 'null' }] },
        },
        required: ['name'],
        additionalProperties: false,
        $defs: { Circle: { type: 'object', properties: { r: { type: 'number' } } } },
      }),
    ).not.toThrow()
  })

  it.each([
    ['const', { const: 1 }],
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['multipleOf', { type: 'number', multipleOf: 3 }],
    ['uniqueItems', { type: 'array', uniqueItems: true }],
    ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }],
    ['minProperties', { type: 'object', minProperties: 1 }],
    ['a uuid format', { type: 'string', format: 'uuid' }],
    [
      'a closed tuple',
      { type: 'array', prefixItems: [{ type: 'string' }], items: false },
    ],
    ['a recursive reference', { type: 'object', properties: { k: { $ref: '#' } } }],
    ['an over-limit maxLength', { type: 'string', maxLength: 5000 }],
    ['a lookahead pattern', { type: 'string', pattern: '^(?=a)' }],
  ])('rejects %s', (_name, schema) => {
    const err = rejection(() =>
      assertPortableJsonSchema(schema as JsonValue, 'call.schema'),
    )
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('call.schema')
    expect(err.message).toContain('the portable subset')
    expect(err.provider).toBeUndefined()
  })
})
