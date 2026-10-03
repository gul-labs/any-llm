import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertJsonSchemaProfile,
  LlmError,
  PORTABLE_JSON_SCHEMA_FORMATS,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
} from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { googleJsonSchemaProfile } from './json-schema.js'
import { geminiModelDescriptors, gemmaModelDescriptors } from './models.js'

interface Cell {
  samples: number
  conforming: number
  violating: number
  nonJson: number
}
interface P3Case {
  keyword: string
  schema: JsonValue
  models: Record<string, Cell>
}
const p3 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/response-json-schema-2026-10-03.json', import.meta.url),
    ),
    'utf8',
  ),
) as { keyOrder: { preserved: number; samples: number }; cases: Record<string, P3Case> }
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
    verdicts: { google: { verdict: string; reason?: string } }
  }>
}

const GEMINI = geminiModelDescriptors.map((d) => d.model)
const GEMMA = gemmaModelDescriptors.map((d) => d.model)
const PROBED_GEMINI = GEMINI.filter((m) => p3.cases['anyOf']?.models[m] !== undefined)

function run(schema: JsonValue, model: string, path = 'output.jsonSchema'): void {
  assertJsonSchemaProfile(schema, path, googleJsonSchemaProfile(model))
}
function rejection(schema: JsonValue, model = 'gemini-3.1-flash-lite', path?: string) {
  try {
    run(schema, model, path)
  } catch (err) {
    if (err instanceof LlmError) return err
    throw err
  }
  throw new Error('expected rejection')
}

describe('Google JSON Schema profile, against live probe P3 (2026-10-03)', () => {
  it('probed every registered Gemini model that was available to the key', () => {
    // gemini-2.5-flash-lite was HTTP 404 for the probing key, so it is the only absentee.
    expect(PROBED_GEMINI.sort()).toEqual(
      GEMINI.filter((m) => m !== 'gemini-2.5-flash-lite').sort(),
    )
    expect(p3.keyOrder.preserved).toBe(p3.keyOrder.samples)
  })

  /** Keywords P3 showed enforced (or, for the soft ones, obeyed with violations). */
  const ACCEPTED = [
    'baseline_key_order',
    'schema_annotation',
    'ref_defs',
    'ref_recursive',
    'anyOf',
    'additionalProperties_false',
    'additionalProperties_schema',
    'minimum_maximum',
    'enum',
    'format',
    'minItems_maxItems',
    'prefixItems',
    'prefixItems_items_false',
    'type_array_null',
    'required_optional',
    'pattern',
    'minLength_maxLength',
  ]
  /** Keywords P3 showed ignored or reinterpreted. */
  const REJECTED = [
    'const',
    'oneOf_discriminated',
    'oneOf_overlapping_probe',
    'exclusiveMinimum_multipleOf',
    'uniqueItems',
    'allOf',
  ]
  const SOFT = ['pattern', 'minLength_maxLength']

  it('classifies every probed schema exactly once', () => {
    expect([...ACCEPTED, ...REJECTED].sort()).toEqual(Object.keys(p3.cases).sort())
  })

  it.each(ACCEPTED)('accepts %s on every Gemini model', (id) => {
    const c = p3.cases[id] as P3Case
    for (const model of GEMINI) run(c.schema, model)
    if (!SOFT.includes(id)) {
      // Enforced: every probed sample on every Gemini model conformed.
      for (const model of PROBED_GEMINI) {
        const cell = c.models[model] as Cell
        expect(cell.violating, `${id} on ${model}`).toBe(0)
        expect(cell.conforming, `${id} on ${model}`).toBe(cell.samples)
      }
    }
  })

  it.each(SOFT)(
    '%s is accepted but only probabilistically obeyed (hosts must validate)',
    (id) => {
      const c = p3.cases[id] as P3Case
      const violations = PROBED_GEMINI.reduce(
        (sum, model) => sum + (c.models[model] as Cell).violating,
        0,
      )
      expect(violations).toBeGreaterThan(0)
    },
  )

  it.each(REJECTED)(
    'rejects %s on every model, and P3 saw it ignored on every model',
    (id) => {
      const c = p3.cases[id] as P3Case
      for (const model of [...GEMINI, ...GEMMA]) {
        const err = rejection(c.schema, model)
        expect(err).toMatchObject({ kind: 'bad_request', provider: 'google' })
      }
      if (id !== 'oneOf_discriminated') {
        // (disjoint oneOf branches happen to conform; the overlapping probe shows the reinterpretation)
        for (const model of PROBED_GEMINI) {
          expect(
            (c.models[model] as Cell).violating,
            `${id} on ${model}`,
          ).toBeGreaterThan(0)
        }
      }
    },
  )

  it('names the path of the unenforced keyword', () => {
    const err = rejection(
      { type: 'object', properties: { kind: { type: 'string', const: 'x' } } },
      undefined,
      'tools[1].inputJsonSchema',
    )
    expect(err.message).toContain('tools[1].inputJsonSchema.properties.kind')
    expect(err.message).toContain('`const`')
  })

  it('Gemma ignored format and length bounds, so the Gemma profile rejects them', () => {
    for (const id of ['format', 'minLength_maxLength']) {
      const c = p3.cases[id] as P3Case
      for (const model of GEMMA) {
        expect((c.models[model] as Cell).violating, `${id} on ${model}`).toBeGreaterThan(
          5,
        )
        expect(() => run(c.schema, model)).toThrow(/does not enforce|enforces `format`/)
        run(c.schema, 'gemini-3.1-pro-preview')
      }
    }
    // Everything else Gemma conformed on stays accepted.
    for (const id of ['anyOf', 'ref_defs', 'enum', 'pattern', 'prefixItems']) {
      for (const model of GEMMA) run((p3.cases[id] as P3Case).schema, model)
    }
  })

  it('accepts $ref/$defs, recursion included, which P3 saw honoured on every model', () => {
    for (const id of ['ref_defs', 'ref_recursive']) {
      for (const model of [...GEMINI, ...GEMMA])
        run((p3.cases[id] as P3Case).schema, model)
    }
  })

  it('accepts only the verified format values', () => {
    for (const format of ['date-time', 'date', 'time', 'email']) {
      run({ type: 'string', format }, 'gemini-3.1-flash-lite')
    }
    expect(rejection({ type: 'string', format: 'uuid' }).message).toContain('"uuid"')
    expect(rejection({ type: 'string', format: 'uri' }).message).toContain('"uri"')
  })

  it('accepts annotations everywhere', () => {
    run(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'a',
        $comment: 'b',
        title: 'T',
        description: 'd',
        type: 'object',
        examples: [{}],
        default: {},
        deprecated: true,
        readOnly: true,
        writeOnly: false,
      },
      'gemini-3.1-flash-lite',
    )
  })

  it('rejects the OpenAPI dialect: nullable, uppercase types, null-only anyOf is fine', () => {
    expect(
      rejection({ type: 'object', properties: { a: { type: 'string', nullable: true } } })
        .message,
    ).toContain('properties.a')
    expect(rejection({ type: 'OBJECT' }).message).toContain('"OBJECT"')
    run({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'gemini-3.1-flash-lite')
  })

  it('declares a superset of the portable subset', () => {
    for (const model of [...GEMINI, ...GEMMA]) {
      const profile = googleJsonSchemaProfile(model)
      for (const keyword of PORTABLE_JSON_SCHEMA_KEYWORDS) {
        if (
          model.startsWith('gemma-') &&
          ['format', 'minLength', 'maxLength'].includes(keyword)
        ) {
          continue
        }
        expect(profile.keywords, `${keyword} on ${model}`).toContain(keyword)
      }
      for (const format of PORTABLE_JSON_SCHEMA_FORMATS) {
        expect(profile.formats).toContain(format)
      }
    }
  })

  describe('pinned Zod output', () => {
    it.each(zodPinned.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      for (const path of ['output.jsonSchema', 'tools[0].inputJsonSchema']) {
        const expected = c.verdicts.google
        if (expected.verdict === 'accept') {
          expect(() => run(c.schema, 'gemini-3.1-flash-lite', path)).not.toThrow()
        } else {
          const err = rejection(c.schema, 'gemini-3.1-flash-lite', path)
          expect(err.message).toContain(path)
          expect(err.message).toContain(expected.reason ?? '')
        }
      }
    })
  })
})
