#!/usr/bin/env node
/**
 * Packed-install checks for the lockstep release contract (see RELEASING.md,
 * "Versioning: one version for every package").
 *
 * Packs every public workspace package exactly as `changeset publish` would, serves
 * the tarballs from a throwaway registry on 127.0.0.1 (the `@gullabs` scope only;
 * every third-party dependency still comes from the real registry), installs them
 * into projects under the OS temp directory with pnpm and npm, and proves:
 *
 *   (a) a direct provider set (core plus every provider and companion package)
 *   (b) the facade on its own
 *   (c) the facade plus a direct provider
 *
 * each resolve exactly one copy of `@gullabs/core`, load under both ESM and CJS,
 * and typecheck an example. The negative cases then install mixed versions (core at
 * a different patch; core at a different minor, both repacked from this tree's own
 * tarballs so no network is needed beyond the third-party registry) and require
 * pnpm's strict peer check to reject them. The drizzle tarball must ship `sql/` and
 * `@gullabs/drizzle/sql/*` must resolve. Nothing is published anywhere. Packages must
 * already be built (`pnpm -r build`). The temp directory, the throwaway registry and
 * every child process group are cleaned up on success, failure and Ctrl-C.
 *
 *   node scripts/packed-install.mjs [--pm pnpm,npm] [--keep]
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const keep = args.includes('--keep')
const pmFlag = args.indexOf('--pm')
const managers = (pmFlag >= 0 ? (args[pmFlag + 1] ?? '') : 'pnpm,npm')
  .split(',')
  .filter(Boolean)
for (const pm of managers) {
  if (pm !== 'pnpm' && pm !== 'npm') throw new Error(`unknown package manager: ${pm}`)
}

const CORE = '@gullabs/core'
const FACADE = '@gullabs/any-llm'

const failures = []
const record = (ok, label, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n      ${detail}`}`,
  )
  if (!ok) failures.push(label)
}
const tail = (text, n = 12) => text.trim().split('\n').slice(-n).join('\n      ')

/** Child process groups still running; killed on timeout, failure and signals. */
const liveGroups = new Set()
const killGroup = (pid) => {
  try {
    // A negative pid signals the whole group: pnpm and npm spawn grandchildren.
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}
const killAll = () => {
  for (const pid of liveGroups) killGroup(pid)
  liveGroups.clear()
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    killAll()
    process.exit(130)
  })
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, cmdArgs, {
      ...opts,
      detached: true,
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
        npm_config_userconfig: '/dev/null',
        npm_config_update_notifier: 'false',
        ...opts.env,
      },
    })
    liveGroups.add(child.pid)
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => killGroup(child.pid), 5 * 60_000)
    child.on('error', (err) => {
      // e.g. ENOENT: no `close` event follows a failed spawn.
      clearTimeout(timer)
      liveGroups.delete(child.pid)
      done({ status: 1, out: String(err) })
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      // Leftover grandchildren of a finished command must not outlive it.
      killGroup(child.pid)
      liveGroups.delete(child.pid)
      done({ status: status ?? 1, out })
    })
  })
}

async function must(cmd, cmdArgs, opts) {
  const res = await run(cmd, cmdArgs, opts)
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed:\n${res.out}`)
  return res.out
}

// --- workspace manifests ----------------------------------------------------

const workspace = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(
    (e) => e.isDirectory() && existsSync(join(root, 'packages', e.name, 'package.json')),
  )
  .map((e) => {
    const dir = join(root, 'packages', e.name)
    return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
  })
  .filter(({ manifest }) => manifest.private !== true)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
for (const { dir, manifest } of workspace) {
  if (!existsSync(join(dir, 'dist', 'index.js'))) {
    throw new Error(`${manifest.name} is not built; run \`pnpm -r build\` first`)
  }
}
const byName = Object.fromEntries(workspace.map((w) => [w.manifest.name, w.manifest]))
const coreVersion = byName[CORE].version
const [maj, min, pat] = coreVersion.split('.').map(Number)
const otherPatch = `${maj}.${min}.${pat + 1}`
const otherMinor = `${maj}.${min + 1}.0`

// --- scratch space and packing ----------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'anyllm-packed-'))
const tarballDir = join(scratch, 'tarballs')
mkdirSync(tarballDir)
console.log(`scratch: ${scratch}`)

let registry
let crashed = false
try {
  const tarballName = (name, version) =>
    `${name.replace('@', '').replace('/', '-')}-${version}.tgz`

  /** Everything the local registry serves: `{ name, version, file }`. */
  const published = []
  for (const { dir, manifest } of workspace) {
    await must('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: dir })
    const file = join(tarballDir, tarballName(manifest.name, manifest.version))
    if (!existsSync(file)) throw new Error(`missing tarball for ${manifest.name}`)
    published.push({ name: manifest.name, version: manifest.version, file })
  }
  const tgz = Object.fromEntries(published.map((p) => [p.name, p.file]))

  /** Read the manifest that was actually packed (what a consumer's package manager sees). */
  const packedManifest = async (file) =>
    JSON.parse(await must('tar', ['-xOzf', file, 'package/package.json']))

  /** Register a copy of a package with an edited manifest, as a different version. */
  async function registerVariant(name, version, edit) {
    const dir = mkdtempSync(join(scratch, 'repack-'))
    await must('tar', ['-xzf', tgz[name], '-C', dir])
    const manifestPath = join(dir, 'package', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.version = version
    edit(manifest)
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const file = join(tarballDir, tarballName(name, version))
    await must('tar', ['-czf', file, '-C', dir, 'package'])
    published.push({ name, version, file })
  }

  // Mixed-version fixtures: this tree's own core tarball re-registered under another
  // version, next to this tree's unchanged companion tarballs (whose peer is exact).
  // Same minor, different patch; and a different minor.
  await registerVariant(CORE, otherPatch, () => {})
  await registerVariant(CORE, otherMinor, () => {})

  // --- manifest contract on the packed tarballs -------------------------------

  for (const { name, file } of published.filter(
    (p) => byName[p.name]?.version === p.version,
  )) {
    if (name === CORE) continue
    const m = await packedManifest(file)
    const peer = m.peerDependencies?.[CORE]
    record(
      peer === coreVersion,
      `${name}: packed peerDependency on ${CORE} is exactly ${coreVersion}`,
      `got ${JSON.stringify(peer)}`,
    )
    record(
      m.dependencies?.[CORE] === undefined,
      `${name}: ${CORE} is not a regular dependency`,
      JSON.stringify(m.dependencies),
    )
    record(
      !JSON.stringify(m).includes('workspace:'),
      `${name}: no workspace: specifier survives packing`,
    )
  }
  {
    // Once `changeset version` has run (no pending changesets) every public package
    // carries the same version. While changesets are pending the versions differ.
    const pending = readdirSync(join(root, '.changeset')).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    )
    if (pending.length === 0) {
      const versions = [...new Set(workspace.map((w) => w.manifest.version))]
      record(
        versions.length === 1,
        'no pending changesets: every public package has the same version',
        versions.join(', '),
      )
    } else {
      console.log(
        `SKIP  lockstep version equality (${pending.length} pending changeset(s))`,
      )
    }
  }

  {
    // Apache-2.0 4(d): every tarball carries the license and the NOTICE text.
    for (const { name } of workspace.map((w) => ({ name: w.manifest.name }))) {
      const listing = (await must('tar', ['-tzf', tgz[name]])).split('\n')
      for (const file of ['package/LICENSE', 'package/NOTICE']) {
        record(
          listing.includes(file),
          `${name}: the tarball ships ${file.replace('package/', '')}`,
        )
      }
      for (const file of ['LICENSE', 'NOTICE']) {
        const packed = await must('tar', ['-xOzf', tgz[name], `package/${file}`])
        record(
          packed === readFileSync(join(root, file), 'utf8'),
          `${name}: the packed ${file} equals the repository's`,
        )
      }
    }
  }

  {
    // The drizzle tarball must ship the SQL it documents.
    const listing = await must('tar', ['-tzf', tgz['@gullabs/drizzle']])
    for (const file of [
      'package/sql/install.sql',
      'package/sql/upgrades/0001-add-error-reason.sql',
      'package/sql/upgrades/0002-ledger-v2.sql',
      'package/sql/upgrades/0003-validate-checks.sql',
      'package/sql/upgrades/0004-llm-call-payloads.sql',
    ]) {
      record(
        listing.split('\n').includes(file),
        `@gullabs/drizzle: the tarball ships ${file.replace('package/', '')}`,
      )
    }
  }

  // --- local registry for the @gullabs scope ------------------------------------

  const sha = (file, alg, enc) => createHash(alg).update(readFileSync(file)).digest(enc)

  async function startRegistry() {
    const server = createServer()
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    const base = `http://127.0.0.1:${server.address().port}`
    const aged = '2020-01-01T00:00:00.000Z'
    server.on('request', async (req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', base).pathname)
      if (path.startsWith('/-/tarballs/')) {
        const entry = published.find((p) =>
          p.file.endsWith(path.slice('/-/tarballs/'.length)),
        )
        if (entry === undefined) return void res.writeHead(404).end()
        return void res
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end(readFileSync(entry.file))
      }
      const name = path.slice(1)
      const entries = published.filter((p) => p.name === name)
      if (entries.length === 0) return void res.writeHead(404).end('{}')
      const versions = {}
      for (const e of entries) {
        const manifest = await packedManifest(e.file)
        versions[e.version] = {
          ...manifest,
          _id: `${name}@${e.version}`,
          dist: {
            tarball: `${base}/-/tarballs/${tarballName(name, e.version)}`,
            shasum: sha(e.file, 'sha1', 'hex'),
            integrity: `sha512-${sha(e.file, 'sha512', 'base64')}`,
          },
        }
      }
      const latest = byName[name].version
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          name,
          'dist-tags': { latest },
          versions,
          time: {
            created: aged,
            modified: aged,
            ...Object.fromEntries(entries.map((e) => [e.version, aged])),
          },
        }),
      )
    })
    return { base, close: () => server.close() }
  }

  registry = await startRegistry()

  // --- fixture projects --------------------------------------------------------

  const callSite = `export const site = defineCallSite({
  id: 'packed-install',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  userTemplate: 'Say {{word}}',
})
export const run = () => client.runStructured(site, { word: 'hi' }, { auth: { apiKey: 'unused' } })
`

  // Type-level examples: they are compiled against the installed .d.ts files, never run.
  const examples = {
    direct: `import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import { xaiProvider } from '@gullabs/xai'
import { claudeCliProvider } from '@gullabs/claude-cli'
import { codexCliProvider } from '@gullabs/codex-cli'
import { drizzleUsageSink, llmCalls, llmCallPayloads } from '@gullabs/drizzle'
import { providerQuotaMiddleware } from '@gullabs/quota'
import { RecordingSink } from '@gullabs/testing'

export { drizzleUsageSink, llmCalls, llmCallPayloads, providerQuotaMiddleware }
const client = createClient({
  ...composeProviders([googleProvider(), xaiProvider(), claudeCliProvider(), codexCliProvider()]),
  sink: new RecordingSink(),
})
${callSite}`,
    facade: `import { createClient, composeProviders, defineCallSite, googleProvider } from '@gullabs/any-llm'

const client = createClient({ ...composeProviders([googleProvider()]) })
${callSite}`,
    both: `import { createClient, composeProviders, defineCallSite, googleProvider } from '@gullabs/any-llm'
import { xaiProvider } from '@gullabs/xai'

const client = createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })
${callSite}`,
  }

  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      types: [],
      strict: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['example.ts'],
  }

  /** Write a throwaway project and install into it. `deps` are the direct dependencies. */
  async function install(pm, label, { deps, autoInstallPeers }) {
    const dir = join(scratch, `${pm}-${label}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: `fixture-${label}`, private: true, type: 'module', dependencies: deps },
        null,
        2,
      ),
    )
    writeFileSync(join(dir, '.npmrc'), `@gullabs:registry=${registry.base}/\n`)
    if (pm === 'pnpm') {
      const yaml = [
        'strictPeerDependencies: true',
        ...(autoInstallPeers === undefined
          ? []
          : [`autoInstallPeers: ${autoInstallPeers}`]),
        '',
      ].join('\n')
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml)
    }
    const res =
      pm === 'pnpm'
        ? await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
            cwd: dir,
          })
        : await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
            cwd: dir,
          })
    return { dir, ...res }
  }

  /** Real directories of `@gullabs/core` anywhere under node_modules (symlinks are not followed). */
  function coreCopies(dir) {
    const found = new Set()
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = join(d, e.name)
        if (e.name === '@gullabs' && d.endsWith('node_modules')) {
          const c = join(p, 'core')
          if (existsSync(join(c, 'package.json'))) found.add(realpathSync(c))
        }
        walk(p)
      }
    }
    walk(join(dir, 'node_modules'))
    return [...found]
  }

  /** Resolve `@gullabs/core` from the real install location of each root dependency. */
  async function resolvedCoreFrom(dir, names) {
    const script = `
    import { createRequire } from 'node:module'
    import { realpathSync } from 'node:fs'
    import { join } from 'node:path'
    const out = {}
    for (const n of ${JSON.stringify(names)}) {
      const real = realpathSync(join(process.cwd(), 'node_modules', n))
      out[n] = realpathSync(createRequire(join(real, 'x.js')).resolve('@gullabs/core'))
    }
    console.log(JSON.stringify(out))
  `
    const res = await run('node', ['--input-type=module', '-e', script], { cwd: dir })
    if (res.status !== 0) throw new Error(res.out)
    return JSON.parse(res.out.trim().split('\n').pop())
  }

  async function check(pm, label, names, example, settings) {
    const tag = `${pm} ${label}`
    const installed = await install(pm, label, settings)
    if (installed.status !== 0)
      return record(false, `${tag}: install`, tail(installed.out))
    record(
      true,
      `${tag}: install succeeds (${pm === 'pnpm' ? 'strict peers' : 'npm peer rules'})`,
    )

    const copies = coreCopies(installed.dir)
    record(
      copies.length === 1,
      `${tag}: exactly one ${CORE} copy on disk`,
      copies.join(', '),
    )

    const resolved = await resolvedCoreFrom(installed.dir, names)
    record(
      new Set(Object.values(resolved)).size === 1 &&
        Object.values(resolved)[0] === copies[0] + '/dist/index.cjs',
      `${tag}: every package resolves ${CORE} to that one copy`,
      JSON.stringify(resolved, null, 2),
    )

    const smoke = `
    import { createRequire } from 'node:module'
    const require = createRequire(import.meta.url)
    for (const n of ${JSON.stringify(names)}) {
      const esm = await import(n)
      const cjs = require(n)
      if (Object.keys(esm).length === 0 || Object.keys(cjs).length === 0) throw new Error(n + ' has no exports')
    }
  `
    const loaded = await run('node', ['--input-type=module', '-e', smoke], {
      cwd: installed.dir,
    })
    record(loaded.status === 0, `${tag}: ESM and CJS load`, tail(loaded.out))

    if (names.includes('@gullabs/testing')) {
      // The test package must work at runtime, not just typecheck: its fakes load
      // the provider packages' classifiers and the SDK error classes through
      // optional peer dependencies, which resolve differently under pnpm and npm
      // and in the ESM and CommonJS builds. One success and one classified
      // provider failure, through the real engine, in both module systems.
      const fakeProbe = `
      import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const ok = {
        message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
        usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
        model: 'gemini-3.6-flash',
        warnings: [],
      }
      const request = {
        provider: 'google',
        model: 'gemini-3.6-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      }
      async function exercise(label, core, google, testing) {
        const adapter = new testing.FakeAdapter('google', [
          ok,
          testing.fakeProviderError('google', 'per-day-quota'),
        ])
        const client = core.createClient({
          adapters: [adapter],
          modelRegistry: google.defaultGeminiRegistry,
        })
        const first = await client.generate(request, { auth: { apiKey: 'unused' } })
        if (first.model !== 'gemini-3.6-flash') throw new Error(label + ': unexpected result')
        const err = await client
          .generate(request, { auth: { apiKey: 'unused' } })
          .catch((e) => e)
        if (!(err instanceof core.LlmError) || err.reason !== 'daily_quota' || err.retryable !== false) {
          throw new Error(label + ': provider error not classified: ' + String(err?.stack ?? err))
        }
      }
      await exercise(
        'esm',
        await import('@gullabs/core'),
        await import('@gullabs/google'),
        await import('@gullabs/testing'),
      )
      await exercise(
        'cjs',
        require('@gullabs/core'),
        require('@gullabs/google'),
        require('@gullabs/testing'),
      )
    `
      const fakeRes = await run('node', ['--input-type=module', '-e', fakeProbe], {
        cwd: installed.dir,
      })
      record(
        fakeRes.status === 0,
        `${tag}: @gullabs/testing fakes run (a fake call and a classified provider error, ESM and CJS)`,
        tail(fakeRes.out),
      )
    }

    if (names.includes('@gullabs/drizzle')) {
      const sqlProbe = `
      import { createRequire } from 'node:module'
      import { existsSync } from 'node:fs'
      import { fileURLToPath } from 'node:url'
      const require = createRequire(import.meta.url)
      for (const f of [
        'install.sql',
        'upgrades/0001-add-error-reason.sql',
        'upgrades/0002-ledger-v2.sql',
        'upgrades/0003-validate-checks.sql',
        'upgrades/0004-llm-call-payloads.sql',
      ]) {
        const viaRequire = require.resolve('@gullabs/drizzle/sql/' + f)
        const viaImport = fileURLToPath(import.meta.resolve('@gullabs/drizzle/sql/' + f))
        if (!existsSync(viaRequire) || !existsSync(viaImport)) throw new Error('missing ' + f)
      }
    `
      const sqlRes = await run('node', ['--input-type=module', '-e', sqlProbe], {
        cwd: installed.dir,
      })
      record(
        sqlRes.status === 0,
        `${tag}: @gullabs/drizzle/sql/* resolves (require and import)`,
        tail(sqlRes.out),
      )
    }

    writeFileSync(join(installed.dir, 'example.ts'), example)
    writeFileSync(join(installed.dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))
    const tsc = await run(
      'node',
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', '.'],
      {
        cwd: installed.dir,
      },
    )
    record(tsc.status === 0, `${tag}: example typechecks`, tail(tsc.out))
  }

  // --- positive cases ------------------------------------------------------------

  const exact = (name) => byName[name].version
  const providerSet = workspace.map((w) => w.manifest.name).filter((n) => n !== FACADE)
  const thirdParty = {
    '@google/genai': byName['@gullabs/google'].peerDependencies['@google/genai'],
    openai: byName['@gullabs/xai'].peerDependencies.openai,
    'drizzle-orm': byName['@gullabs/drizzle'].devDependencies['drizzle-orm'],
  }

  for (const pm of managers) {
    // (a) direct provider set: core is named explicitly, nothing is auto-installed.
    await check(pm, 'a-direct', providerSet, examples.direct, {
      deps: {
        ...Object.fromEntries(providerSet.map((n) => [n, exact(n)])),
        ...thirdParty,
      },
      autoInstallPeers: false,
    })
    // (b) the facade alone: the package manager installs its core peer.
    await check(pm, 'b-facade', [FACADE], examples.facade, {
      deps: { [FACADE]: exact(FACADE) },
    })
    // (c) the facade plus a direct provider.
    await check(pm, 'c-facade-plus-xai', [FACADE, '@gullabs/xai'], examples.both, {
      deps: {
        [FACADE]: exact(FACADE),
        '@gullabs/xai': exact('@gullabs/xai'),
        openai: thirdParty.openai,
      },
    })
  }

  // --- negative cases: mixed versions are rejected ---------------------------------

  const mixed = {
    'same minor, different patch': {
      [CORE]: otherPatch,
      '@gullabs/quota': exact('@gullabs/quota'),
    },
    'different minor': {
      [CORE]: otherMinor,
      '@gullabs/quota': exact('@gullabs/quota'),
    },
  }
  for (const [label, deps] of Object.entries(mixed)) {
    const slug = label.replace(/\W+/g, '-')
    if (managers.includes('pnpm')) {
      const res = await install('pnpm', `neg-${slug}`, { deps })
      record(
        res.status !== 0 && res.out.includes('ERR_PNPM_PEER_DEP_ISSUES'),
        `pnpm strict peers reject mixed versions (${label})`,
        res.status === 0 ? 'install unexpectedly succeeded' : tail(res.out),
      )
    }
    if (managers.includes('npm')) {
      // Informational: the contract is pnpm strict mode, but record what npm does.
      const res = await install('npm', `neg-${slug}`, { deps })
      console.log(
        `INFO  npm on mixed versions (${label}): ${res.status === 0 ? 'installed' : 'rejected'}`,
      )
    }
  }
} catch (err) {
  crashed = true
  console.error(err)
} finally {
  killAll()
  registry?.close()
  if (keep) console.log(`kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

if (crashed || failures.length > 0) {
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`)
  }
  process.exit(1)
}
console.log('\nall packed-install checks passed')
