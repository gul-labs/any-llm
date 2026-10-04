/**
 * Permanence guard: published package.json repository metadata must keep the
 * `gul-labs/any-llm` org/repo path exactly. The path is matched literally against
 * the provenance attestation — a redirect from a former org name does not satisfy
 * it, and neither does different casing (`gullabs` failed this way in Release run
 * 31787709259). The Release workflow compares the same path to `GITHUB_REPOSITORY`
 * immediately before publish. After an org/repo rename, update `repoPath` here
 * first so CI and the Release gate stay aligned.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const packagesRoot = join(workspaceRoot, 'packages')
const repoPath = 'gul-labs/any-llm'
const hostedUrl = `https://github.com/${repoPath}`

type Manifest = {
  name?: string
  private?: boolean
  engines?: { node?: string }
  exports?: Record<string, unknown>
  files?: string[]
  repository?: { type?: string; url?: string; directory?: string }
  homepage?: string
  bugs?: string
}

function publishedManifests(): { dir: string; pkg: Manifest }[] {
  const out: { dir: string; pkg: Manifest }[] = []
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let pkg: Manifest
    try {
      pkg = JSON.parse(
        readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8'),
      ) as Manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (pkg.private === true || typeof pkg.name !== 'string') continue
    out.push({ dir: entry.name, pkg })
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

describe('published package metadata', () => {
  it('discovers public workspace packages', () => {
    expect(publishedManifests().length).toBeGreaterThan(0)
  })

  it.each(publishedManifests())(
    '$dir repository path is exactly gul-labs/any-llm',
    ({ dir, pkg }) => {
      expect(pkg.repository?.type).toBe('git')
      expect(pkg.repository?.directory).toBe(`packages/${dir}`)
      expect(pkg.repository?.url).toMatch(
        new RegExp(`^(?:git\\+)?https://github\\.com/${repoPath}(?:\\.git)?$`),
      )
      expect(pkg.homepage).toBe(`${hostedUrl}/tree/main/packages/${dir}#readme`)
      expect(pkg.bugs).toBe(`${hostedUrl}/issues`)
    },
  )
})

describe('published package license files', () => {
  // Apache-2.0 4(d): the NOTICE text travels with every redistribution. `files` lists
  // NOTICE (npm adds LICENSE on its own), and each package directory holds a copy that
  // must equal the repository's, so a tarball never ships a stale one.
  it.each(publishedManifests())(
    '$dir ships LICENSE and NOTICE equal to the root',
    ({ dir, pkg }) => {
      expect(pkg.files).toContain('NOTICE')
      for (const file of ['LICENSE', 'NOTICE']) {
        expect(readFileSync(join(packagesRoot, dir, file), 'utf8')).toBe(
          readFileSync(join(workspaceRoot, file), 'utf8'),
        )
      }
    },
  )
})

describe('published package runtime contract', () => {
  /** The one Node floor: every `engines.node`, the README, the SPEC and the CI matrix. */
  const floor = '22.12.0'

  it.each(publishedManifests())('$dir declares the Node floor', ({ pkg }) => {
    expect(pkg.engines?.node).toBe(`>=${floor}`)
  })

  it('README and SPEC state the same floor', () => {
    const readme = readFileSync(join(workspaceRoot, 'README.md'), 'utf8')
    const spec = readFileSync(join(workspaceRoot, 'SPEC.md'), 'utf8')
    expect(readme).toContain(`Node \`>=${floor}\``)
    expect(spec).toContain('Node ≥22.12')
  })

  it('the CI node-matrix job runs the tests on the floor (parsed, not grepped)', () => {
    const ci = parseYaml(
      readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8'),
    ) as {
      jobs: Record<
        string,
        { strategy?: { matrix?: { node?: unknown } }; steps?: unknown[] }
      >
    }
    const matrix = ci.jobs['node-matrix']?.strategy?.matrix?.node
    expect(Array.isArray(matrix)).toBe(true)
    expect(matrix).toContain(floor)
    const runs = (ci.jobs['node-matrix']?.steps ?? []).map((step) =>
      String((step as { run?: unknown }).run ?? ''),
    )
    expect(runs.some((run) => run.includes('vitest.mjs run'))).toBe(true)
  })

  it.each(publishedManifests())(
    '$dir serves .d.ts to import and .d.cts to require',
    ({ pkg }) => {
      expect(pkg.exports?.['.']).toEqual({
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      })
    },
  )

  // Every export is accounted for: the entry, `./package.json` (bundlers and license or
  // version scanners read it, and `require.resolve('<pkg>/package.json')` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED without it), and drizzle's shipped SQL.
  it.each(publishedManifests())(
    '$dir exports exactly its entry, package.json and SQL',
    ({ dir, pkg }) => {
      const expected = ['.', './package.json', ...(dir === 'drizzle' ? ['./sql/*'] : [])]
      expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(expected.sort())
      expect(pkg.exports?.['./package.json']).toBe('./package.json')
      if (dir === 'drizzle') {
        expect(pkg.exports?.['./sql/*']).toBe('./sql/*')
        expect(pkg.files).toContain('sql')
        expect(existsSync(join(packagesRoot, dir, 'sql'))).toBe(true)
      }
      expect(pkg.files).toContain('dist')
    },
  )
})
