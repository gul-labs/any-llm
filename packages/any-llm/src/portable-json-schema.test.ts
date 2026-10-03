/**
 * The portable JSON Schema subset (ADR-034) is exactly what Google and xAI both
 * enforce. Core declares it; each provider declares its own profile; this test
 * is the one place that sees all three and keeps them equal.
 */
import { describe, expect, it } from 'vitest'
import {
  PORTABLE_JSON_SCHEMA_FORMATS,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
} from '@gullabs/core'
import { googleJsonSchemaProfile } from '../../google/src/json-schema.js'
import { XAI_JSON_SCHEMA_PROFILE } from '../../xai/src/json-schema.js'

const intersection = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((item) => b.includes(item)).sort()

describe('portable JSON Schema subset', () => {
  const google = googleJsonSchemaProfile('gemini-3.1-pro-preview')

  it('keywords are the intersection of the Google and xAI profiles', () => {
    expect([...PORTABLE_JSON_SCHEMA_KEYWORDS].sort()).toEqual(
      intersection(google.keywords, XAI_JSON_SCHEMA_PROFILE.keywords),
    )
  })

  it('formats are the intersection of the two format sets', () => {
    expect([...PORTABLE_JSON_SCHEMA_FORMATS].sort()).toEqual(
      intersection(google.formats, XAI_JSON_SCHEMA_PROFILE.formats),
    )
  })
})
