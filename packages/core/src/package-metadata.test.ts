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

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const packagesRoot = join(workspaceRoot, 'packages')
const repoPath = 'gul-labs/any-llm'
const hostedUrl = `https://github.com/${repoPath}`

type Manifest = {
  name?: string
  private?: boolean
  engines?: { node?: string }
  exports?: Record<string, unknown>
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

describe('published package runtime contract', () => {
  /** The one Node floor: every `engines.node`, the README, the SPEC and the CI matrix. */
  const floor = '22.12.0'

  it.each(publishedManifests())('$dir declares the Node floor', ({ pkg }) => {
    expect(pkg.engines?.node).toBe(`>=${floor}`)
  })

  it('README, SPEC and the CI matrix state the same floor', () => {
    const readme = readFileSync(join(workspaceRoot, 'README.md'), 'utf8')
    const spec = readFileSync(join(workspaceRoot, 'SPEC.md'), 'utf8')
    const ci = readFileSync(join(workspaceRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(readme).toContain(`Node \`>=${floor}\``)
    expect(spec).toContain('Node ≥22.12')
    expect(ci).toContain(`'${floor}'`)
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
})
