/**
 * The built package, loaded the way a host loads it. `fakeProviderError` finds
 * the SDK classes with `createRequire`, which a bundler can break differently in
 * the ESM and the CommonJS output, so both are run for real. Needs `pnpm build`
 * first (the quality pipeline builds before it tests).
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dist = (name: string): string =>
  fileURLToPath(new URL(`../dist/${name}`, import.meta.url))

const hasDist = existsSync(dist('index.js')) && existsSync(dist('index.cjs'))

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr }
}

describe.skipIf(!hasDist)('the built @gullabs/testing', () => {
  const script =
    "const g = t.fakeProviderError('google', 'bare-429'); const x = t.fakeProviderError('xai', 'safety-check'); console.log(JSON.stringify([g.name, g.status, x.constructor.name, x.status]))"

  it('the CommonJS build builds both provider errors from the real SDK classes', () => {
    const out = run([
      '-e',
      `const t = require(${JSON.stringify(dist('index.cjs'))}); ${script}`,
    ])
    expect(out.stderr).toBe('')
    expect(JSON.parse(out.stdout)).toEqual([
      'ApiError',
      429,
      'PermissionDeniedError',
      403,
    ])
  })

  it('the ESM build builds both provider errors from the real SDK classes', () => {
    const out = run([
      '--input-type=module',
      '-e',
      `import * as t from ${JSON.stringify(dist('index.js'))}; ${script}`,
    ])
    expect(out.stderr).toBe('')
    expect(JSON.parse(out.stdout)).toEqual([
      'ApiError',
      429,
      'PermissionDeniedError',
      403,
    ])
  })
})
