/**
 * Published-artifact check of `@gullabs/openai`'s types: `tsc` runs against the
 * BUILT `packages/core/dist/index.d.ts` and `packages/openai/dist/index.d.ts` in
 * a hermetic temp project (never the monorepo `src` program, where every
 * augmentation is in scope through `paths`).
 *
 * This release has no `providerOptions` lane, so importing `@gullabs/openai`
 * must NOT add an `openai` key to `ProviderOptionsMap`, and its public types must
 * compile on their own.
 *
 * Fails (does not skip) when the dist files are missing: run `pnpm build`.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const coreDts = join(repoRoot, 'packages/core/dist/index.d.ts')
const openaiDts = join(repoRoot, 'packages/openai/dist/index.d.ts')
const tsc = join(repoRoot, 'node_modules/.bin/tsc')

let dir = ''

function compile(source: string): void {
  dir = mkdtempSync(join(tmpdir(), 'anyllm-openai-dist-'))
  writeFileSync(join(dir, 'fixture.ts'), source)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        isolatedModules: true,
        paths: { '@gullabs/core': [coreDts], '@gullabs/openai': [openaiDts] },
      },
      files: ['fixture.ts'],
    }),
  )
  try {
    execFileSync(tsc, ['--noEmit', '--project', join(dir, 'tsconfig.json')], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string }
    throw new Error(`${e.stdout ?? ''}${e.stderr ?? ''}` || e.message)
  }
}

describe('published @gullabs/openai types', () => {
  beforeAll(() => {
    for (const file of [coreDts, openaiDts]) {
      if (!existsSync(file)) {
        throw new Error(
          `Missing built declaration file: ${file}. Run \`pnpm build\` first.`,
        )
      }
    }
  })

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('compiles a host that composes the provider and reads its types', () => {
    expect(() =>
      compile(`
import { composeProviders, createClient } from '@gullabs/core'
import { openaiProvider, OPENAI_PRICING } from '@gullabs/openai'
import type { OpenAiClientLike, OpenAiReplayState } from '@gullabs/openai'

const client = createClient({ ...composeProviders([openaiProvider()]) })
declare const fake: OpenAiClientLike
declare const state: OpenAiReplayState
void client; void fake; void state; void OPENAI_PRICING
`),
    ).not.toThrow()
  })

  it('adds no openai key to ProviderOptionsMap', () => {
    expect(() =>
      compile(`
import type { ProviderOptions } from '@gullabs/core'
import type { OpenAiClientLike } from '@gullabs/openai'
type _Keep = OpenAiClientLike
declare const opts: ProviderOptions
const lane = opts.openai
void lane
`),
    ).toThrow(/openai/)
  })
})
