/**
 * The portable JSON Schema subset (ADR-034) is what the Gemini 3.x and xAI
 * profiles both enforce. Core declares it; each provider declares its own
 * profile; this test is the one place that sees all of them and keeps every
 * field of the portable profile equal to the combination of the others.
 *
 * Not claimed here, and not true: that the subset is enforced by Gemma 4 (a
 * stricter profile, checked below) or by the CLI providers (`claude-cli` and
 * `codex-cli` do not run these checks).
 */
import { describe, expect, it } from 'vitest'
import {
  assertJsonSchemaProfile,
  PORTABLE_JSON_SCHEMA_FORMATS,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
  assertPortableJsonSchema,
} from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { googleJsonSchemaProfile } from '../../google/src/json-schema.js'
import { geminiModelDescriptors, gemmaModelDescriptors } from '../../google/src/models.js'
import { XAI_JSON_SCHEMA_PROFILE } from '../../xai/src/json-schema.js'

const intersection = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((item) => b.includes(item)).sort()

const GEMINI_3 = geminiModelDescriptors
  .map((d) => d.model)
  .filter((model) => model.startsWith('gemini-3'))
const GEMMA = gemmaModelDescriptors.map((d) => d.model)
const xai = XAI_JSON_SCHEMA_PROFILE

/**
 * Probe a behaviour of the portable profile through its public entry point.
 * `assertPortableJsonSchema` is the only way to reach it; compare it against
 * the same schema run through each provider profile.
 */
function accepts(run: () => void): boolean {
  try {
    run()
    return true
  } catch {
    return false
  }
}

describe('portable JSON Schema subset', () => {
  it('covers every Gemini 3.x model the Google package registers', () => {
    expect(GEMINI_3.length).toBeGreaterThanOrEqual(6)
    expect(GEMMA.length).toBeGreaterThanOrEqual(2)
  })

  describe.each(GEMINI_3)('against %s and xAI', (model) => {
    const google = googleJsonSchemaProfile(model)

    it('keywords are the intersection of the two profiles', () => {
      expect([...PORTABLE_JSON_SCHEMA_KEYWORDS].sort()).toEqual(
        intersection(google.keywords, xai.keywords),
      )
    })

    it('formats are the intersection of the two format sets', () => {
      expect([...PORTABLE_JSON_SCHEMA_FORMATS].sort()).toEqual(
        intersection(google.formats, xai.formats),
      )
    })

    it('the hard-coded limits are the smaller declared limit of each portable keyword', () => {
      const limitKeys = new Set([
        ...Object.keys(google.limits),
        ...Object.keys(xai.limits),
      ])
      const expected: Record<string, number> = {}
      for (const key of limitKeys) {
        if (!PORTABLE_JSON_SCHEMA_KEYWORDS.includes(key)) continue
        const declared = [google.limits[key], xai.limits[key]].filter(
          (value): value is number => value !== undefined,
        )
        expected[key] = Math.min(...declared)
      }
      expect(portableLimits()).toEqual(expected)
    })

    it('recursion is supported only when both profiles support it', () => {
      expect(accepts(() => assertPortableJsonSchema(RECURSIVE))).toBe(
        google.circularRefs && xai.circularRefs,
      )
    })

    it('closed tuples (items: false) are supported only when both profiles support them', () => {
      expect(accepts(() => assertPortableJsonSchema(CLOSED_TUPLE))).toBe(
        google.booleanItems && xai.booleanItems,
      )
    })

    it('patterns are held to the regex subset when either profile holds them to it', () => {
      expect(accepts(() => assertPortableJsonSchema(LOOKAHEAD))).toBe(
        !(google.patternSubset || xai.patternSubset),
      )
    })
  })

  it('Gemma is stricter than the portable subset: it additionally drops format, minLength and maxLength', () => {
    for (const model of GEMMA) {
      const gemma = googleJsonSchemaProfile(model)
      const missing = PORTABLE_JSON_SCHEMA_KEYWORDS.filter(
        (keyword) => !gemma.keywords.includes(keyword),
      )
      expect(missing.sort()).toEqual(['format', 'maxLength', 'minLength'])
      // A schema inside the portable subset can still be rejected on Gemma.
      const schema: JsonValue = {
        type: 'object',
        properties: { d: { type: 'string', format: 'date' } },
      }
      expect(accepts(() => assertPortableJsonSchema(schema))).toBe(true)
      expect(accepts(() => assertJsonSchemaProfile(schema, 'x', gemma))).toBe(false)
    }
  })

  it('the exported lists cannot be changed by a host', () => {
    expect(Object.isFrozen(PORTABLE_JSON_SCHEMA_KEYWORDS)).toBe(true)
    expect(Object.isFrozen(PORTABLE_JSON_SCHEMA_FORMATS)).toBe(true)
  })
})

const RECURSIVE: JsonValue = {
  type: 'object',
  properties: { kids: { type: 'array', items: { $ref: '#' } } },
}
const CLOSED_TUPLE: JsonValue = {
  type: 'array',
  prefixItems: [{ type: 'string' }],
  items: false,
}
const LOOKAHEAD: JsonValue = { type: 'string', pattern: '^(?=a)' }

/**
 * The portable `limits`, observed: the largest value of each limited keyword
 * the portable check still accepts. Found by bisecting each candidate keyword
 * (every keyword any shipped profile limits), so the test reads the shipped
 * constant instead of copying it.
 */
function portableLimits(): Record<string, number> {
  const found: Record<string, number> = {}
  const candidates = new Set([
    ...Object.keys(googleJsonSchemaProfile('gemini-3.1-pro-preview').limits),
    ...Object.keys(xai.limits),
  ])
  for (const keyword of candidates) {
    if (!PORTABLE_JSON_SCHEMA_KEYWORDS.includes(keyword)) continue
    const type = keyword.endsWith('Length')
      ? 'string'
      : keyword.endsWith('Items')
        ? 'array'
        : 'object'
    const ok = (value: number): boolean =>
      accepts(() => assertPortableJsonSchema({ type, [keyword]: value } as JsonValue))
    let low = 0
    let high = 1_000_000
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (ok(mid)) low = mid
      else high = mid - 1
    }
    found[keyword] = low
  }
  return found
}
