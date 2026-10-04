/**
 * What the drizzle tarball must contain and how its SQL files are named.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url))

describe('@gullabs/drizzle package', () => {
  it('numbers the upgrade files uniquely and in the order they apply (a numeric-prefix runner rejects duplicates)', () => {
    const files = readdirSync(here('../sql/upgrades')).filter((f) => f.endsWith('.sql'))
    const prefixes = files.map((f) => /^(\d{4})-[a-z0-9-]+\.sql$/.exec(f)?.[1])
    expect(
      prefixes.every((p) => p !== undefined),
      files.join(', '),
    ).toBe(true)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    expect(files).toEqual([...files].sort())
    expect(prefixes.map(Number)).toEqual(prefixes.map((_, i) => i + 1))
  })

  it('names the files the guides and the schema check point at', () => {
    const files = readdirSync(here('../sql/upgrades'))
    expect(files).toEqual([
      '0001-add-error-reason.sql',
      '0002-ledger-v2.sql',
      '0003-validate-checks.sql',
      '0004-llm-call-payloads.sql',
    ])
  })

  it('ships the repository LICENSE and NOTICE (npm packs them from the package directory)', () => {
    for (const name of ['LICENSE', 'NOTICE']) {
      expect(readFileSync(here(`../${name}`), 'utf8')).toBe(
        readFileSync(here(`../../../${name}`), 'utf8'),
      )
    }
  })
})
