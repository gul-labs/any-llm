#!/usr/bin/env node
/**
 * Self-test for scripts/audit.mjs.
 *
 * The gate exists because npm's advisory service fails in ways that look like
 * success, so the gate itself has to be proven against every failure shape
 * rather than against whatever npm happens to be doing today. That matters most
 * for the CLEAN path: while the service is degraded it cannot produce a healthy
 * response at all, so without these fakes the "service is up and the tree is
 * clean" branch would ship unverified.
 *
 * The advisory service is faked with a local HTTP server, so every branch is
 * deterministic and offline.
 *
 * Usage: node scripts/audit.test.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'audit.mjs')

const CANARY_ADVISORY = {
  id: 1523,
  severity: 'high',
  title: 'Command Injection in lodash',
  url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
}

/** A lockfile containing the given `name@version` keys. */
function makeLockfile(keys) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lock-'))
  const file = join(dir, 'pnpm-lock.yaml')
  const entries = keys
    .map((k) => `  '${k}':\n    resolution: {integrity: sha512-x}\n`)
    .join('\n')
  const body = `lockfileVersion: '9.0'\n\npackages:\n\n${entries}`
  writeFileSync(file, body)
  return file
}

/**
 * Advisory service fake.
 *   healthy   flags the canary, plus whatever `findings` says
 *   degraded  200 OK but an empty dataset (the dangerous shape)
 *   error     503
 *   hang      never responds
 */
function startService(mode, findings = {}) {
  const server = createServer((req, res) => {
    if (mode === 'error') {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'Service Unavailable' }))
      return
    }
    if (mode === 'degraded') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }
    if (mode === 'healthy') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ lodash: [CANARY_ADVISORY], ...findings }))
      return
    }
    // mode === 'hang' — reproduces the 2026-09-04 socket timeouts.
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }),
    )
  })
}

function runGate({ url, lockfile, extraArgs = [], env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [GATE, '--audit-level=high', `--lockfile=${lockfile}`, ...extraArgs],
      {
        env: {
          ...process.env,
          AUDIT_CANARY_URL: url,
          AUDIT_RETRIES: '2',
          AUDIT_BASE_DELAY_MS: '1',
          AUDIT_TIMEOUT_MS: '300',
          GITHUB_ACTIONS: '',
          AUDIT_REQUIRE_VERDICT: '',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('close', (code) => resolve({ code, out }))
  })
}

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

async function withService(mode, findings, fn) {
  const { server, url } = await startService(mode, findings)
  try {
    return await fn(url)
  } finally {
    server.close()
    server.closeAllConnections?.()
  }
}

const cleanLock = makeLockfile(['@babel/parser@7.29.7', 'react@19.0.0'])
const vulnerableLock = makeLockfile(['@babel/parser@7.29.7', 'minimist@1.2.5'])
// A workspace that genuinely depends on the canary version must still be flagged.
const canaryLock = makeLockfile(['lodash@4.17.20'])

console.log('audit gate self-test')

// The branches an outage makes untestable against the real service.
await withService('healthy', {}, async (url) => {
  const clean = await runGate({ url, lockfile: cleanLock })
  check(
    'service healthy + no findings -> CLEAN, exit 0',
    clean.code === 0 && /CLEAN/.test(clean.out),
    `exit=${clean.code} out=${clean.out.trim()}`,
  )
})

await withService(
  'healthy',
  { minimist: [{ id: 2, severity: 'critical', title: 'Prototype Pollution' }] },
  async (url) => {
    const vuln = await runGate({ url, lockfile: vulnerableLock })
    check(
      'service healthy + real finding -> VULNERABLE, exit 1',
      vuln.code === 1 && /VULNERABLE/.test(vuln.out) && /minimist/.test(vuln.out),
      `exit=${vuln.code} out=${vuln.out.trim()}`,
    )
  },
)

// Below-threshold findings must not fail a --audit-level=high gate.
await withService(
  'healthy',
  { minimist: [{ id: 3, severity: 'low', title: 'Minor issue' }] },
  async (url) => {
    const low = await runGate({ url, lockfile: vulnerableLock })
    check(
      'service healthy + below-threshold finding -> CLEAN, exit 0',
      low.code === 0 && /CLEAN/.test(low.out),
      `exit=${low.code} out=${low.out.trim()}`,
    )
  },
)

// The canary is scaffolding, unless the workspace really uses that version.
await withService('healthy', {}, async (url) => {
  const real = await runGate({ url, lockfile: canaryLock })
  check(
    'canary version genuinely installed -> reported as a real finding',
    real.code === 1 && /VULNERABLE/.test(real.out) && /lodash/.test(real.out),
    `exit=${real.code} out=${real.out.trim()}`,
  )
})

// The regression that motivated the gate: never launder "could not check" into
// "clean", in any of the shapes npm actually produced.
for (const mode of ['hang', 'error', 'degraded']) {
  await withService(mode, {}, async (url) => {
    const result = await runGate({ url, lockfile: cleanLock })
    check(
      `service ${mode} -> UNDETERMINED, never reported as CLEAN`,
      result.code === 0 && /UNDETERMINED/.test(result.out) && !/CLEAN/.test(result.out),
      `exit=${result.code} out=${result.out.trim()}`,
    )

    const strict = await runGate({
      url,
      lockfile: cleanLock,
      env: { AUDIT_REQUIRE_VERDICT: '1' },
    })
    check(
      `service ${mode} + AUDIT_REQUIRE_VERDICT=1 -> exit 1`,
      strict.code === 1 && /UNDETERMINED/.test(strict.out),
      `exit=${strict.code} out=${strict.out.trim()}`,
    )
  })
}

await withService('hang', {}, async (url) => {
  const annotated = await runGate({
    url,
    lockfile: cleanLock,
    env: { GITHUB_ACTIONS: 'true' },
  })
  check(
    'UNDETERMINED emits a ::warning:: annotation under GitHub Actions',
    /::warning::/.test(annotated.out),
    annotated.out.trim(),
  )
})

// An empty or unreadable lockfile must never read as "nothing to audit".
await withService('healthy', {}, async (url) => {
  const emptyLock = makeLockfile([])
  const empty = await runGate({ url, lockfile: emptyLock })
  check(
    'lockfile with no packages -> refuses to report clean, exit 1',
    empty.code === 1 && !/CLEAN/.test(empty.out),
    `exit=${empty.code} out=${empty.out.trim()}`,
  )

  const missing = await runGate({ url, lockfile: '/nonexistent/pnpm-lock.yaml' })
  check(
    'missing lockfile -> refuses to report clean, exit 1',
    missing.code === 1 && !/CLEAN/.test(missing.out),
    `exit=${missing.code} out=${missing.out.trim()}`,
  )
})

// --prod uses pnpm's own resolution instead of the lockfile. Faked with a PATH
// shim so the walker is exercised without needing a vulnerable prod tree.
function makePnpmShim(stdout, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-shim-'))
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`,
  )
  chmodSync(join(dir, 'pnpm'), 0o755)
  return dir
}

const PROD_TREE = JSON.stringify([
  {
    name: 'root',
    dependencies: {
      react: { version: '19.2.8' },
      minimist: { version: '1.2.5', dependencies: { nested: { version: '2.0.0' } } },
    },
  },
])

await withService(
  'healthy',
  { minimist: [{ id: 4, severity: 'critical', title: 'Prototype Pollution' }] },
  async (url) => {
    const shim = makePnpmShim(PROD_TREE)
    const prod = await runGate({
      url,
      lockfile: cleanLock,
      extraArgs: ['--prod'],
      env: { PATH: `${shim}:${process.env.PATH}` },
    })
    check(
      '--prod walks the pnpm tree and flags a transitive prod finding',
      prod.code === 1 && /VULNERABLE/.test(prod.out) && /minimist/.test(prod.out),
      `exit=${prod.code} out=${prod.out.trim()}`,
    )

    const emptyShim = makePnpmShim('[]')
    const emptyProd = await runGate({
      url,
      lockfile: cleanLock,
      extraArgs: ['--prod'],
      env: { PATH: `${emptyShim}:${process.env.PATH}` },
    })
    check(
      '--prod with an empty tree -> refuses to report clean, exit 1',
      emptyProd.code === 1 && !/CLEAN/.test(emptyProd.out),
      `exit=${emptyProd.code} out=${emptyProd.out.trim()}`,
    )
  },
)

if (failures > 0) {
  console.error(`\naudit gate self-test: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\naudit gate self-test: all checks passed')
