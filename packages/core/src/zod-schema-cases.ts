/**
 * Zod schemas whose `z.toJSONSchema()` output is pinned in
 * `__fixtures__/zod-4.6.5-json-schemas.json` (ADR-034).
 *
 * Each case carries the verdict every provider profile and the portable subset
 * must give the pinned output. A Zod upgrade that changes the emitted JSON
 * fails `zod-schema-fixtures.test.ts`; regenerate the fixture locally with
 * `PIN_ZOD_FIXTURES=1 pnpm vitest run packages/core/src/zod-schema-fixtures.test.ts`
 * (refused when `CI` is set), review the diff, and re-decide the verdicts.
 *
 * Test support only: not exported from the package.
 *
 * @module
 */

import { z } from 'zod'

type Verdict = { verdict: 'accept' } | { verdict: 'reject'; reason: string }

interface ZodSchemaCase {
  readonly name: string
  readonly description: string
  readonly build: () => z.ZodType
  readonly options?: { reused?: 'inline' | 'ref' }
  readonly verdicts: { google: Verdict; xai: Verdict; portable: Verdict }
}

/**
 * Whether this run re-pins the fixture (`PIN_ZOD_FIXTURES=1`). Pinning rewrites
 * the file the same run then compares against, so it would always pass: it is
 * refused (throws) when `CI` is set.
 */
export function pinRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env['PIN_ZOD_FIXTURES'] !== '1') return false
  if (env['CI'] !== undefined && env['CI'] !== '') {
    throw new Error(
      'PIN_ZOD_FIXTURES=1 rewrites the fixture the tests compare against, so it is refused when CI is set. Re-pin locally and commit the diff.',
    )
  }
  return true
}

const accept: Verdict = { verdict: 'accept' }
const reject = (reason: string): Verdict => ({ verdict: 'reject', reason })
const acceptAll = { google: accept, xai: accept, portable: accept }

const Item = z.object({ n: z.string() })

export const ZOD_SCHEMA_CASES: readonly ZodSchemaCase[] = [
  {
    name: 'object_optional_nullable',
    description: 'optional and nullable fields, bounded integer',
    build: () =>
      z.object({
        a: z.string().optional(),
        b: z.string().nullable(),
        c: z.number().int().min(1).max(5),
        d: z.boolean(),
        e: z.number(),
      }),
    verdicts: acceptAll,
  },
  {
    name: 'nullable_object_and_array',
    description: 'nullable object and array (anyOf with a null branch)',
    build: () => z.object({ a: Item.nullable(), l: z.array(Item).nullable() }),
    verdicts: acceptAll,
  },
  {
    name: 'string_enum',
    description: 'z.enum',
    build: () => z.object({ e: z.enum(['a', 'b']) }),
    verdicts: acceptAll,
  },
  {
    name: 'literal_union_enum',
    description: 'z.literal with several values emits enum',
    build: () => z.object({ k: z.literal(['a', 'b']) }),
    verdicts: acceptAll,
  },
  {
    name: 'array_of_objects',
    description: 'bounded array of objects',
    build: () => z.object({ l: z.array(Item).min(1).max(3) }),
    verdicts: acceptAll,
  },
  {
    name: 'string_bounds_and_pattern',
    description: 'minLength, maxLength and a simple pattern',
    build: () => z.object({ s: z.string().min(1).max(10).regex(/^a+$/) }),
    verdicts: acceptAll,
  },
  {
    name: 'string_formats_portable',
    description: 'email, date-time and date formats (each with a Zod-generated pattern)',
    build: () => z.object({ e: z.email(), d: z.iso.datetime(), dd: z.iso.date() }),
    verdicts: acceptAll,
  },
  {
    name: 'string_formats_uuid_uri',
    description: 'uuid and uri formats: xAI enforces them, Google does not',
    build: () => z.object({ u: z.uuid(), url: z.url() }),
    verdicts: {
      google: reject('"uuid"'),
      xai: accept,
      portable: reject('"uuid"'),
    },
  },
  {
    name: 'literal',
    description: 'z.literal emits const, which Google ignores',
    build: () => z.object({ k: z.literal('x') }),
    verdicts: {
      google: reject('`const`'),
      xai: accept,
      portable: reject('`const`'),
    },
  },
  {
    name: 'discriminated_union',
    description: 'z.discriminatedUnion emits oneOf (with const discriminators)',
    build: () =>
      z.object({
        u: z.discriminatedUnion('t', [
          z.object({ t: z.literal('a'), x: z.string() }),
          z.object({ t: z.literal('b'), y: z.number() }),
        ]),
      }),
    verdicts: {
      google: reject('`oneOf`'),
      xai: reject('`oneOf`'),
      portable: reject('`oneOf`'),
    },
  },
  {
    name: 'discriminated_union_enum_discriminator',
    description: 'a discriminated union still emits oneOf even without literals to blame',
    build: () =>
      z.object({
        u: z.discriminatedUnion('t', [
          z.object({ t: z.enum(['a']), x: z.string() }),
          z.object({ t: z.enum(['b']), y: z.number() }),
        ]),
      }),
    verdicts: {
      google: reject('`oneOf`'),
      xai: reject('`oneOf`'),
      portable: reject('`oneOf`'),
    },
  },
  {
    name: 'union_of_objects',
    description: 'z.union of objects emits anyOf',
    build: () =>
      z.object({
        u: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      }),
    verdicts: acceptAll,
  },
  {
    name: 'union_of_primitives',
    description: 'z.union of primitives emits a multi-type array',
    build: () => z.object({ u: z.union([z.string(), z.number()]) }),
    verdicts: {
      google: reject('anyOf'),
      xai: reject('anyOf'),
      portable: reject('anyOf'),
    },
  },
  {
    name: 'root_anyof_intersection',
    description: 'an intersection with a union distributes into a root anyOf',
    build: () =>
      z.intersection(
        z.object({ a: z.string() }),
        z.union([z.object({ b: z.string() }), z.object({ c: z.string() })]),
      ),
    verdicts: acceptAll,
  },
  {
    name: 'reused_default',
    description: 'a type used twice, default reuse mode (inlined)',
    build: () => z.object({ a: Item, b: Item }),
    verdicts: acceptAll,
  },
  {
    name: 'reused_inline',
    description: "a type used twice, reused: 'inline'",
    build: () => z.object({ a: Item, b: Item }),
    options: { reused: 'inline' },
    verdicts: acceptAll,
  },
  {
    name: 'reused_ref',
    description: "a type used twice, reused: 'ref' emits $defs and $ref",
    build: () => z.object({ a: Item, b: Item }),
    options: { reused: 'ref' },
    verdicts: acceptAll,
  },
  {
    name: 'recursive',
    description: 'a recursive type emits a root $ref: Google honours it, xAI does not',
    build: () => {
      const Category: z.ZodType = z.object({
        name: z.string(),
        get kids() {
          return z.array(Category)
        },
      })
      return Category
    },
    verdicts: {
      google: accept,
      xai: reject('circular'),
      portable: reject('circular'),
    },
  },
  {
    name: 'tuple',
    description: 'z.tuple emits prefixItems with items: false',
    build: () => z.object({ t: z.tuple([z.string(), z.number()]) }),
    verdicts: {
      google: accept,
      xai: reject('closed tuple'),
      portable: reject('closed tuple'),
    },
  },
  {
    name: 'record',
    description:
      "z.record(z.string(), X) emits propertyNames: { type: 'string' }, a no-op the profiles accept",
    build: () => z.object({ r: z.record(z.string(), z.number()) }),
    verdicts: acceptAll,
  },
  {
    name: 'record_enum_keys',
    description:
      'z.record with enum keys emits a constraining propertyNames (and required)',
    build: () => z.object({ r: z.record(z.enum(['a', 'b']), z.number()) }),
    verdicts: {
      google: reject('`propertyNames`'),
      xai: reject('`propertyNames`'),
      portable: reject('`propertyNames`'),
    },
  },
  {
    name: 'record_pattern_keys',
    description: 'z.record with a regex key schema emits propertyNames with a pattern',
    build: () => z.object({ r: z.record(z.string().regex(/^k/), z.number()) }),
    verdicts: {
      google: reject('`propertyNames`'),
      xai: reject('`propertyNames`'),
      portable: reject('`propertyNames`'),
    },
  },
  {
    name: 'string_starts_with',
    description:
      'startsWith emits format: starts_with next to a pattern; the format is not enforced anywhere',
    build: () => z.object({ s: z.string().startsWith('a') }),
    verdicts: {
      google: reject('"starts_with"'),
      xai: reject('"starts_with"'),
      portable: reject('"starts_with"'),
    },
  },
  {
    name: 'string_starts_with_format_dropped',
    description:
      'the workaround: .meta({ format: undefined }) removes the format and keeps the pattern',
    build: () => z.object({ s: z.string().startsWith('a').meta({ format: undefined }) }),
    verdicts: acceptAll,
  },
  {
    name: 'string_regex_equivalent',
    description: 'the other workaround: z.string().regex() emits the pattern alone',
    build: () => z.object({ s: z.string().regex(/^a.*/) }),
    verdicts: acceptAll,
  },
  {
    name: 'string_duration',
    description:
      'z.iso.duration emits format: duration and a lookahead pattern, outside every profile',
    build: () => z.object({ s: z.iso.duration() }),
    verdicts: {
      google: reject('"duration"'),
      xai: reject('"duration"'),
      portable: reject('"duration"'),
    },
  },
  {
    name: 'annotations',
    description: 'default and describe emit annotations only',
    build: () => z.object({ a: z.string().default('x').describe('a field') }),
    verdicts: acceptAll,
  },
  {
    name: 'any',
    description: 'z.any emits an empty schema',
    build: () => z.object({ a: z.any() }),
    verdicts: acceptAll,
  },
]
