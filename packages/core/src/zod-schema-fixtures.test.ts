/**
 * The pinned Zod fixture (ADR-034): `z.toJSONSchema()` output of the cases in
 * `zod-schema-cases.ts`, each with the verdict the Google profile, the xAI
 * profile and the portable subset must give it. This file checks the pin
 * against the installed Zod and the portable column against core; the provider
 * packages check their own columns against the same JSON.
 *
 * Re-pin after a Zod upgrade: `PIN_ZOD_FIXTURES=1 pnpm vitest run
 * packages/core/src/zod-schema-fixtures.test.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LlmError } from './errors.js'
import { assertPortableJsonSchema } from './json-schema.js'
import type { JsonValue } from './types.js'
import { ZOD_SCHEMA_CASES } from './zod-schema-cases.js'

const FIXTURE_URL = new URL('./__fixtures__/zod-4.6.5-json-schemas.json', import.meta.url)

interface PinnedCase {
  name: string
  description: string
  options?: { reused?: string }
  schema: JsonValue
  verdicts: Record<'google' | 'xai' | 'portable', { verdict: string; reason?: string }>
}
interface Pinned {
  zodVersion: string
  source: string
  cases: PinnedCase[]
}

function generate(): Pinned {
  return {
    zodVersion: '4.6.5',
    source:
      'z.toJSONSchema() of the schemas in packages/core/src/zod-schema-cases.ts, generated with the installed Zod (default options unless a case sets them). Verdicts are the expected outcome of each provider profile and of the portable subset on that output.',
    cases: ZOD_SCHEMA_CASES.map((c) => ({
      name: c.name,
      description: c.description,
      ...(c.options !== undefined ? { options: c.options } : {}),
      schema: z.toJSONSchema(c.build(), c.options) as JsonValue,
      verdicts: c.verdicts,
    })),
  }
}

if (process.env['PIN_ZOD_FIXTURES'] === '1') {
  writeFileSync(
    fileURLToPath(FIXTURE_URL),
    `${JSON.stringify(generate(), null, 2)}\n`,
    'utf8',
  )
}

const pinned = JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), 'utf8')) as Pinned

describe('pinned Zod JSON Schema fixture', () => {
  it('was generated with the installed Zod version', () => {
    expect(pinned.zodVersion).toBe(
      (
        JSON.parse(
          readFileSync(fileURLToPath(import.meta.resolve('zod/package.json')), 'utf8'),
        ) as { version: string }
      ).version,
    )
  })

  it('matches what the installed Zod emits today, schemas and verdicts', () => {
    expect(pinned).toEqual(generate())
  })

  it('covers each shape the plan names', () => {
    const names = pinned.cases.map((c) => c.name)
    for (const needed of [
      'object_optional_nullable',
      'string_enum',
      'array_of_objects',
      'string_formats_portable',
      'discriminated_union',
      'union_of_objects',
      'reused_default',
      'reused_inline',
      'reused_ref',
    ]) {
      expect(names).toContain(needed)
    }
  })

  it('pins that z.literal emits const and a discriminated union emits oneOf', () => {
    const byName = (n: string) => pinned.cases.find((c) => c.name === n) as PinnedCase
    expect(JSON.stringify(byName('literal').schema)).toContain('"const":"x"')
    expect(JSON.stringify(byName('discriminated_union').schema)).toContain('"oneOf"')
    expect(JSON.stringify(byName('union_of_objects').schema)).toContain('"anyOf"')
    expect(JSON.stringify(byName('reused_ref').schema)).toContain('"$ref":"#/$defs/')
  })

  describe.each(pinned.cases)('$name', (c) => {
    it('gets the portable verdict, as an output schema and as a tool parameter', () => {
      for (const path of ['output.jsonSchema', 'tools[0].inputJsonSchema']) {
        const run = (): void => assertPortableJsonSchema(c.schema, path)
        const expected = c.verdicts.portable
        if (expected.verdict === 'accept') {
          expect(run).not.toThrow()
        } else {
          let error: unknown
          try {
            run()
          } catch (e) {
            error = e
          }
          expect(error).toBeInstanceOf(LlmError)
          expect((error as LlmError).kind).toBe('bad_request')
          expect((error as LlmError).message).toContain(path)
          expect((error as LlmError).message).toContain(expected.reason)
        }
      }
    })
  })
})
