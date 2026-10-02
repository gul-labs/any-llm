import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { assertXaiOutputJsonSchema } from './output-schema.js'

function rejection(schema: JsonValue): LlmError {
  try {
    assertXaiOutputJsonSchema(schema)
  } catch (err) {
    if (err instanceof LlmError) return err
    throw err
  }
  throw new Error('expected assertXaiOutputJsonSchema to throw')
}

describe('assertXaiOutputJsonSchema', () => {
  it('rejects a nullable keyword and names the nested path', () => {
    const err = rejection({
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
    expect(err.provider).toBe('xai')
    expect(err.message).toContain(
      '`properties.company.properties.offices.items.properties.city`',
    )
    expect(err.message).toContain("type: ['string', 'null']")
  })

  it('rejects nullable: false too — the keyword is not JSON Schema', () => {
    expect(rejection({ type: 'string', nullable: false }).message).toContain('`<root>`')
  })

  it('rejects an uppercase Gemini type name with its path', () => {
    const err = rejection({
      type: 'object',
      properties: { name: { type: 'STRING' } },
    })
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('"STRING"')
    expect(err.message).toContain('`properties.name`')
  })

  it('rejects an uppercase root type', () => {
    expect(rejection({ type: 'OBJECT', properties: {} }).message).toContain('`<root>`')
  })

  it('rejects an uppercase member inside a type array', () => {
    const err = rejection({
      type: 'object',
      properties: { count: { type: ['INTEGER', 'null'] } },
    })
    expect(err.message).toContain('"INTEGER"')
    expect(err.message).toContain('`properties.count`')
  })

  it('rejects a non-string type member', () => {
    expect(rejection({ type: [1] as never }).message).toContain('1')
  })

  it.each([
    ['anyOf', { anyOf: [{ type: 'string' }, { type: 'NULL' }] }, '`anyOf[1]`'],
    ['oneOf', { oneOf: [{ type: 'string', nullable: true }] }, '`oneOf[0]`'],
    ['allOf', { allOf: [{ type: 'OBJECT' }] }, '`allOf[0]`'],
    ['$defs', { $defs: { Leader: { type: 'OBJECT' } } }, '`$defs.Leader`'],
    [
      'definitions',
      { definitions: { Leader: { nullable: true } } },
      '`definitions.Leader`',
    ],
    ['prefixItems', { prefixItems: [{ type: 'STRING' }] }, '`prefixItems[0]`'],
    ['items tuple', { items: [{ type: 'string' }, { type: 'NUMBER' }] }, '`items[1]`'],
    [
      'additionalProperties',
      { additionalProperties: { type: 'STRING' } },
      '`additionalProperties`',
    ],
    [
      'patternProperties',
      { patternProperties: { '^x': { nullable: true } } },
      '`patternProperties.^x`',
    ],
    ['not', { not: { type: 'STRING' } }, '`not`'],
    ['if/then/else', { if: {}, then: {}, else: { type: 'ARRAY' } }, '`else`'],
    ['contains', { contains: { type: 'BOOLEAN' } }, '`contains`'],
    [
      'dependentSchemas',
      { dependentSchemas: { a: { nullable: true } } },
      '`dependentSchemas.a`',
    ],
    ['propertyNames', { propertyNames: { type: 'STRING' } }, '`propertyNames`'],
    [
      'unevaluatedProperties',
      { unevaluatedProperties: { type: 'STRING' } },
      '`unevaluatedProperties`',
    ],
    ['unevaluatedItems', { unevaluatedItems: { type: 'STRING' } }, '`unevaluatedItems`'],
    ['contentSchema', { contentSchema: { type: 'STRING' } }, '`contentSchema`'],
  ])('walks %s', (_name, schema, path) => {
    expect(rejection(schema as JsonValue).message).toContain(path)
  })

  it('accepts standard JSON Schema, including null unions', () => {
    const schema: JsonValue = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        employees: { type: ['integer', 'null'] },
        founded: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string' } },
        active: { type: 'boolean' },
        leader: { $ref: '#/$defs/Leader' },
      },
      required: ['name'],
      $defs: { Leader: { type: 'object', properties: { name: { type: 'string' } } } },
    }
    const before = JSON.stringify(schema)
    expect(() => assertXaiOutputJsonSchema(schema)).not.toThrow()
    expect(JSON.stringify(schema)).toBe(before)
  })

  it('does not require additionalProperties: false or a complete required list', () => {
    expect(() =>
      assertXaiOutputJsonSchema({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
      }),
    ).not.toThrow()
  })

  it('accepts properties that are themselves named nullable or type', () => {
    expect(() =>
      assertXaiOutputJsonSchema({
        type: 'object',
        properties: {
          nullable: { type: 'boolean' },
          type: { type: 'string', enum: ['STRING', 'OBJECT'] },
        },
        required: ['nullable', 'type'],
      }),
    ).not.toThrow()
  })

  it('accepts dialect words inside data positions', () => {
    expect(() =>
      assertXaiOutputJsonSchema({
        type: 'object',
        description: 'nullable: true, type STRING',
        properties: {
          kind: { const: 'STRING' },
          label: { type: 'string', enum: ['OBJECT', 'nullable'], default: 'OBJECT' },
          sample: { type: 'object', examples: [{ type: 'STRING', nullable: true }] },
        },
      }),
    ).not.toThrow()
  })

  it('ignores a non-object schema value', () => {
    expect(() => assertXaiOutputJsonSchema(true)).not.toThrow()
    expect(() => assertXaiOutputJsonSchema('x')).not.toThrow()
  })
})
