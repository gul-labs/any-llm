/**
 * Lockstep release contract, source side: every public package is in the one
 * changesets `fixed` group, and `@gullabs/core` is an exact-version peer of every
 * other package (`workspace:*` publishes as the exact release version) plus a
 * devDependency for builds, never a regular dependency. The packed-tarball side is
 * `scripts/packed-install.mjs`.
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(import.meta.dirname, '../../..')
const CORE = '@gullabs/core'

type Manifest = {
  name: string
  private?: boolean
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifests: Manifest[] = readdirSync(join(workspaceRoot, 'packages'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map(
    (entry) =>
      JSON.parse(
        readFileSync(join(workspaceRoot, 'packages', entry.name, 'package.json'), 'utf8'),
      ) as Manifest,
  )
  .filter((pkg) => pkg.private !== true)

describe('lockstep versioning', () => {
  it('puts every public package in a single changesets fixed group', () => {
    const config = JSON.parse(
      readFileSync(join(workspaceRoot, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] }
    expect(config.fixed).toHaveLength(1)
    expect([...(config.fixed[0] ?? [])].sort()).toEqual(
      manifests.map((m) => m.name).sort(),
    )
  })

  it.each(manifests.filter((m) => m.name !== CORE).map((m) => [m.name, m] as const))(
    '%s takes core as an exact peer plus a devDependency, not a dependency',
    (_name, pkg) => {
      expect(pkg.peerDependencies?.[CORE]).toBe('workspace:*')
      expect(pkg.devDependencies?.[CORE]).toBe('workspace:*')
      expect(pkg.dependencies?.[CORE]).toBeUndefined()
    },
  )

  it('keeps core free of @gullabs dependencies', () => {
    const core = manifests.find((m) => m.name === CORE)
    const all = { ...core?.dependencies, ...core?.peerDependencies }
    expect(Object.keys(all).filter((n) => n.startsWith('@gullabs/'))).toEqual([])
  })
})
