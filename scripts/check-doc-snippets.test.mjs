#!/usr/bin/env node
/**
 * Self-test for scripts/check-doc-snippets.mjs: fence extraction, and that a fence
 * which does not typecheck fails the check with the markdown file and line.
 *
 * Usage: node scripts/check-doc-snippets.test.mjs   (needs `pnpm -r build` first)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverFiles, extractFences } from './check-doc-snippets.mjs'

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

// Discovery: the files are found by walking the tree, not from a list.
const found = new Set(discoverFiles())
for (const file of [
  'README.md',
  'SPEC.md',
  'DESIGN.md',
  'CONTRIBUTING.md',
  'docs/ledger.md',
  'docs/architecture.md',
  'packages/core/README.md',
  'packages/any-llm/README.md',
  'packages/any-llm/skills/any-llm/SKILL.md',
]) {
  assert.ok(found.has(file), `${file} is checked`)
}
for (const file of found) {
  assert.ok(!file.startsWith('docs/archive/'), `${file} is archived history`)
  assert.ok(!file.includes('node_modules'), `${file} is vendored`)
  assert.ok(!/(^|\/)(CHANGELOG|DECISIONS)\.md$/.test(file), `${file} is history`)
}

const tree = mkdtempSync(join(tmpdir(), 'doc-discovery-test-'))
try {
  const put = (file) => {
    mkdirSync(dirname(join(tree, file)), { recursive: true })
    writeFileSync(join(tree, file), '# x\n')
  }
  for (const file of [
    'README.md',
    'NEW-ROOT-DOC.md',
    'docs/brand-new.md',
    'docs/nested/deeper.md',
    'docs/archive/old-plan.md',
    'packages/one/README.md',
    'packages/one/skills/s/SKILL.md',
    'packages/one/docs/extra.md',
    'packages/one/CHANGELOG.md',
    'packages/one/node_modules/dep/README.md',
    'packages/one/dist/notes.md',
    'node_modules/top/README.md',
    '.hidden/notes.md',
    'examples/notes.md',
  ])
    put(file)
  assert.deepEqual(discoverFiles(tree).sort(), [
    'NEW-ROOT-DOC.md',
    'README.md',
    'docs/brand-new.md',
    'docs/nested/deeper.md',
    'packages/one/README.md',
    'packages/one/docs/extra.md',
    'packages/one/skills/s/SKILL.md',
  ])
} finally {
  rmSync(tree, { recursive: true, force: true })
}
console.log('check-doc-snippets: ok')
