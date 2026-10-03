#!/usr/bin/env node
/**
 * Typechecks the TypeScript code fences in the user-facing docs against the BUILT
 * packages (`pnpm -r build` first), so a README example cannot drift from the API.
 *
 *   node scripts/check-doc-snippets.mjs [file.md ...]   (default: the files in `FILES`)
 *
 * Rules (deterministic, offline):
 *
 *   - Every fence whose info string is exactly `ts` is a standalone module and is
 *     compiled. It must typecheck under the repo's strict compiler options.
 *   - A fence that is intentionally a fragment (it leans on variables defined in
 *     prose, or on code that is not part of this repository) is written
 *     ```` ```ts no-check ```` and is skipped. Use it sparingly: a fence that is
 *     almost complete should be completed instead.
 *   - Other languages (`bash`, `sql`, `json`, ...) are ignored.
 *
 * Scope: the files listed in `FILES`. Design records (ADRs, plans, audits, the
 * archive) describe what was decided at a point in time and are not checked.
 *
 * How it compiles: the snippets are written to `node_modules/.cache/doc-snippets`,
 * one file per fence, next to a `node_modules` of symlinks: `@gullabs/*` point at
 * the workspace packages (so the real `exports` maps and built `.d.ts` files are what
 * resolve) and third-party imports point at whatever the workspace already installed.
 * Nothing is downloaded and nothing is written outside `node_modules/.cache`.
 *
 * @module
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules', '.cache', 'doc-snippets')

/** Markdown files whose `ts` fences are compiled, relative to the repo root. */
const FILES = [
  'README.md',
  'CONTRIBUTING.md',
  ...readdirSync(join(root, 'packages'))
    .sort()
    .map((name) => `packages/${name}/README.md`)
    .filter((file) => existsSync(join(root, file))),
  'docs/architecture.md',
  'docs/grounded-structured.md',
  'docs/ledger.md',
  'docs/multi-runtime.md',
  'docs/structured-output-validation.md',
]

/** Extract `{ file, line, code }` for each checked `ts` fence of one markdown file. */
export function extractFences(markdown) {
  const lines = markdown.split('\n')
  const fences = []
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (open === null) {
      const m = /^(\s*)(`{3,})\s*(\S*)\s*(.*)$/.exec(line)
      if (m)
        open = { ticks: m[2], lang: m[3], flags: m[4].trim(), start: i + 2, body: [] }
      continue
    }
    if (line.trim() === open.ticks) {
      if (open.lang === 'ts' && open.flags === '') {
        fences.push({ line: open.start, code: open.body.join('\n') })
      } else if (open.lang === 'ts' && open.flags !== 'no-check') {
        throw new Error(`unknown fence marker "${open.flags}" at line ${open.start - 1}`)
      }
      open = null
      continue
    }
    open.body.push(line)
  }
  if (open !== null) throw new Error(`unterminated code fence at line ${open.start - 1}`)
  return fences
}

/** Bare module specifiers imported by a snippet. */
function importedPackages(code) {
  const names = new Set()
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    const parts = spec.split('/')
    names.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])
  }
  return names
}

/** The installed directory of `name`, found from any workspace package. */
function locatePackage(name) {
  const bases = [
    root,
    ...readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d)),
  ]
  for (const base of bases) {
    const dir = join(base, 'node_modules', ...name.split('/'))
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir)
  }
  return undefined
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, 'dir')
}

function main(files) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = []
  const packages = new Set()
  for (const file of files) {
    const fences = extractFences(readFileSync(resolve(root, file), 'utf8'))
    for (const fence of fences) {
      const name = `snippet-${String(manifest.length).padStart(3, '0')}.ts`
      // `export {}` makes a snippet without imports a module (top-level await, own scope);
      // it goes last so the line numbers stay those of the fence.
      writeFileSync(join(outDir, name), `${fence.code}\nexport {}\n`)
      manifest.push({ name, file, line: fence.line })
      for (const pkg of importedPackages(fence.code)) packages.add(pkg)
    }
  }

  if (manifest.length === 0) {
    console.log('doc snippets: no checked fences')
    return
  }

  const missing = []
  for (const pkg of [...packages].sort()) {
    const target = pkg.startsWith('@gullabs/')
      ? join(root, 'packages', pkg.slice('@gullabs/'.length))
      : locatePackage(pkg)
    if (target === undefined || !existsSync(target)) missing.push(pkg)
    else link(target, join(outDir, 'node_modules', ...pkg.split('/')))
  }
  const typesNode = locatePackage('@types/node')
  if (typesNode !== undefined)
    link(typesNode, join(outDir, 'node_modules', '@types', 'node'))
  if (missing.length > 0) {
    console.error(
      `doc snippets import packages that are not installed: ${missing.join(', ')}`,
    )
    process.exit(1)
  }
  for (const pkg of packages) {
    if (!pkg.startsWith('@gullabs/')) continue
    const built = join(
      root,
      'packages',
      pkg.slice('@gullabs/'.length),
      'dist',
      'index.d.ts',
    )
    if (!existsSync(built)) {
      console.error(
        `${pkg} is not built (${relative(root, built)}); run pnpm -r build first`,
      )
      process.exit(1)
    }
  }

  const base = JSON.parse(
    readFileSync(join(root, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  )
  writeFileSync(
    join(outDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          ...base.compilerOptions,
          noEmit: true,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          typeRoots: [join(outDir, 'node_modules', '@types')],
        },
        include: ['*.ts'],
      },
      null,
      2,
    ),
  )

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const run = spawnSync(
    process.execPath,
    [tsc, '-p', join(outDir, 'tsconfig.json'), '--pretty', 'false'],
    {
      encoding: 'utf8',
      cwd: outDir,
    },
  )
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status === 0) {
    console.log(
      `doc snippets: ${manifest.length} fences in ${files.length} files typecheck`,
    )
    return
  }

  const byName = new Map(manifest.map((m) => [m.name, m]))
  const lines = output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = /^(snippet-\d+\.ts)\((\d+),(\d+)\): (.*)$/.exec(l)
      const src = m ? byName.get(m[1]) : undefined
      return m && src ? `${src.file}:${src.line + Number(m[2]) - 1}: ${m[4]}` : l
    })
  console.error(lines.join('\n'))
  console.error(
    '\nA fence that is intentionally a fragment is marked ```ts no-check; otherwise fix the example.',
  )
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2)
  main(args.length > 0 ? args : FILES)
}
