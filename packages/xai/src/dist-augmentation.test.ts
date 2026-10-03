/**
 * Published-artifact enforcement for the `xai` lane of `ProviderOptionsMap`.
 *
 * This is the actual enforcement mechanism for the "published-artifact"
 * contract described in `docs/archive/provider-plugins-and-xai-grok-4-5-plan.md`
 * §2.1 (mirrors `packages/google/src/dist-augmentation.test.ts`). It is
 * distinct from any source-level provider-options test: the root
 * `tsconfig.json` compiles all `packages/*\/src` together via `paths`
 * aliases, so a `declare module '@gullabs/core'` augmentation is globally
 * in scope there regardless of whether `packages/xai/src/index.ts` actually
 * imports/re-exports the declaring module. That makes a source-level test
 * vacuous as a guard for "does importing the published `@gullabs/xai`
 * package really add the `xai` key to `ProviderOptionsMap`".
 *
 * This test proves the real contract by running `tsc` against the *built*
 * `packages/core/dist/index.d.ts` and `packages/xai/dist/index.d.ts` files,
 * in a hermetic temp project that only knows about those two declaration
 * files (never the monorepo's `packages/*\/src` tsconfig program):
 *
 * - `positive.ts` imports only `@gullabs/core` and `@gullabs/xai` (via the
 *   built d.ts files) and must compile cleanly, proving the augmentation
 *   flows through the built `@gullabs/xai` entrypoint into the built
 *   `@gullabs/core` types.
 * - `negative-bogus-key.ts` supplies an unknown `providerOptions` key and
 *   must fail to compile, proving the map is closed to unknown keys.
 * - `core-only-empty.ts` imports only `@gullabs/core` (never `@gullabs/xai`)
 *   and accesses `opts.xai` on a `ProviderOptions` value; this must fail to
 *   compile with "Property 'xai' does not exist", proving
 *   `ProviderOptionsMap` is empty-by-default for consumers who never load
 *   the `@gullabs/xai` package. (It probes via property access rather than
 *   an object-literal assignment because TypeScript's excess-property check
 *   never fires on object literals assigned to an empty-interface target —
 *   `{ xai: {} }` would compile cleanly even with no augmentation in scope,
 *   making that form a vacuous probe.)
 *
 * If `packages/core/dist/index.d.ts` or `packages/xai/dist/index.d.ts` is
 * missing, this test fails loudly (it does not skip) and tells the
 * developer to run `pnpm build` first.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const currentDir = fileURLToPath(new URL('.', import.meta.url))
// packages/xai/src -> repo root is three levels up.
const repoRoot = resolve(currentDir, '../../..')

const coreDtsPath = join(repoRoot, 'packages/core/dist/index.d.ts')
const xaiDtsPath = join(repoRoot, 'packages/xai/dist/index.d.ts')
const tscBinPath = join(repoRoot, 'node_modules/.bin/tsc')

let tempDir: string

function writeTsconfig(dir: string, fixtureFileName: string): string {
  const tsconfigPath = join(dir, 'tsconfig.json')
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022'],
      types: [],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      isolatedModules: true,
      paths: {
        '@gullabs/core': [coreDtsPath],
        '@gullabs/xai': [xaiDtsPath],
      },
    },
    files: [fixtureFileName],
  }
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2))
  return tsconfigPath
}

function compileFixture(fixtureFileName: string, source: string): string {
  const fixturePath = join(tempDir, fixtureFileName)
  writeFileSync(fixturePath, source)
  const tsconfigPath = writeTsconfig(tempDir, fixtureFileName)
  try {
    const output = execFileSync(tscBinPath, ['--noEmit', '--project', tsconfigPath], {
      cwd: tempDir,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return output
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message: string }
    const combined = `${execError.stdout ?? ''}${execError.stderr ?? ''}`
    throw new Error(combined.length > 0 ? combined : execError.message)
  }
}

describe('published-artifact ProviderOptionsMap augmentation (xai)', () => {
  beforeAll(() => {
    if (!existsSync(coreDtsPath)) {
      throw new Error(
        `Missing built declaration file: ${coreDtsPath}\n` +
          'Run `pnpm build` (or `pnpm -r build`) before running this test — ' +
          'it verifies the augmentation against the built dist output, not source.',
      )
    }
    if (!existsSync(xaiDtsPath)) {
      throw new Error(
        `Missing built declaration file: ${xaiDtsPath}\n` +
          'Run `pnpm build` (or `pnpm -r build`) before running this test — ' +
          'it verifies the augmentation against the built dist output, not source.',
      )
    }
  })

  afterEach(() => {
    if (tempDir.length > 0) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('accepts a well-formed xai providerOptions value via @gullabs/xai', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyllm-dist-augmentation-'))
    mkdirSync(tempDir, { recursive: true })
    const source = `
import type { ProviderOptions } from '@gullabs/core'
import type { XaiProviderOptions } from '@gullabs/xai'

const xaiOptions: XaiProviderOptions = {
  promptCacheKey: 'foo',
  tools: [{ type: 'web_search' }],
}

const opts: ProviderOptions = { xai: xaiOptions }
void opts
`
    expect(() => compileFixture('positive.ts', source)).not.toThrow()
  })

  it('rejects an unknown provider key even when @gullabs/xai is imported', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyllm-dist-augmentation-'))
    mkdirSync(tempDir, { recursive: true })
    const source = `
import type { ProviderOptions } from '@gullabs/core'
import type { XaiProviderOptions } from '@gullabs/xai'

// Reference the xai import so it isn't tree-shaken/unused, without
// satisfying the assignment below.
type _KeepImport = XaiProviderOptions

const opts: ProviderOptions = { bogus: {} }
void opts
`
    let thrown: unknown
    try {
      compileFixture('negative-bogus-key.ts', source)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('bogus')
  })

  it('has no xai key at all when only @gullabs/core is imported', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'anyllm-dist-augmentation-'))
    mkdirSync(tempDir, { recursive: true })
    // `ProviderOptionsMap` is an empty interface by default, and TypeScript's
    // excess-property check does not fire on object literals assigned to an
    // empty-interface target (there is nothing to "exceed"). So we prove the
    // key is genuinely absent via a direct property access instead, which
    // fails with "Property 'xai' does not exist" when no provider package
    // has augmented the map.
    const source = `
import type { ProviderOptions } from '@gullabs/core'

declare const opts: ProviderOptions
const xai = opts.xai
void xai
`
    let thrown: unknown
    try {
      compileFixture('core-only-empty.ts', source)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('xai')
  })
})
