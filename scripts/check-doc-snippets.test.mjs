#!/usr/bin/env node
/**
 * Self-test for scripts/check-doc-snippets.mjs: fence extraction, and that a fence
 * which does not typecheck fails the check with the markdown file and line.
 *
 * Usage: node scripts/check-doc-snippets.test.mjs   (needs `pnpm -r build` first)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractFences } from './check-doc-snippets.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-doc-snippets.mjs')
const fence = '```'

// Extraction: `ts` is checked, `ts no-check` and other languages are not.
const md = [
  'intro',
  `${fence}ts`,
  'const a: number = 1',
  fence,
  `${fence}ts no-check`,
  'const b: number = "skipped"',
  fence,
  `${fence}bash`,
  'echo not typescript',
  fence,
].join('\n')
assert.deepEqual(extractFences(md), [{ line: 3, code: 'const a: number = 1' }])
assert.throws(
  () => extractFences(`${fence}ts nocheck\nx\n${fence}`),
  /unknown fence marker/,
)
assert.throws(() => extractFences(`${fence}ts\nx`), /unterminated/)

// The check itself: a good fence passes, a bad one fails and names file:line.
const dir = mkdtempSync(join(tmpdir(), 'doc-snippets-test-'))
try {
  const good = join(dir, 'good.md')
  const bad = join(dir, 'bad.md')
  writeFileSync(good, `${fence}ts\nconst a: number = 1\nexport { a }\n${fence}\n`)
  writeFileSync(
    bad,
    `text\n\n${fence}ts\nconst a: number = 1\nconst b: number = 'x'\n${fence}\n`,
  )
  const ok = spawnSync(process.execPath, [script, good], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const fail = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' })
  assert.equal(fail.status, 1)
  assert.match(
    fail.stderr,
    new RegExp(`${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:5: error TS2322`),
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('check-doc-snippets: ok')
