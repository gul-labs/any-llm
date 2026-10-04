/**
 * The built package, loaded the way a host loads it. `fakeProviderError` finds
 * the SDK classes with `createRequire`, and the fakes load the provider
 * packages' classifiers with a dynamic `import`, which a bundler can break
 * differently in the ESM and the CommonJS output, so both are run for real
 * (against the built `@gullabs/core` and provider packages). Needs `pnpm build`
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

describe.skipIf(!hasDist)(
  'the built fakes classify provider errors like the real adapters',
  () => {
    // A FakeAdapter, throwing a per-day Gemini quota, behind the built engine: the
    // error must come out classified (rate_limited, daily_quota, not retryable)
    // and be an `LlmError` of the same core copy the client was built with.
    const body = `
    const ok = { message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] }, usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null }, model: 'm', warnings: [] }
    const adapter = new t.FakeAdapter('google', [t.fakeProviderError('google', 'per-day-quota'), ok])
    const client = core.createClient({ adapters: [adapter], modelRegistry: google.defaultGeminiRegistry })
    const request = { provider: 'google', model: 'gemini-3.6-flash', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }] }
    const files = new t.FakeGoogleFileStore()
    Promise.all([
      client.generate(request, { auth: { apiKey: 'k' } }).catch((e) => e),
      files.upload(new Uint8Array([1]), 'application/x-foo').catch((e) => e),
    ]).then(([e, f]) => console.log(JSON.stringify([e instanceof core.LlmError, e.kind, e.reason, e.retryable, e.provider, f.kind])))
  `

    const core = (name: string): string =>
      fileURLToPath(new URL(`../../core/dist/${name}`, import.meta.url))
    const google = (name: string): string =>
      fileURLToPath(new URL(`../../google/dist/${name}`, import.meta.url))

    it('CommonJS', () => {
      const out = run([
        '-e',
        `const t = require(${JSON.stringify(dist('index.cjs'))}); const core = require(${JSON.stringify(core('index.cjs'))}); const google = require(${JSON.stringify(google('index.cjs'))}); ${body}`,
      ])
      expect(out.stderr).toBe('')
      expect(JSON.parse(out.stdout)).toEqual([
        true,
        'rate_limited',
        'daily_quota',
        false,
        'google',
        'bad_request',
      ])
    })

    it('ESM', () => {
      const out = run([
        '--input-type=module',
        '-e',
        `import * as t from ${JSON.stringify(dist('index.js'))}; import * as core from ${JSON.stringify(core('index.js'))}; import * as google from ${JSON.stringify(google('index.js'))}; ${body}`,
      ])
      expect(out.stderr).toBe('')
      expect(JSON.parse(out.stdout)).toEqual([
        true,
        'rate_limited',
        'daily_quota',
        false,
        'google',
        'bad_request',
      ])
    })
  },
)
