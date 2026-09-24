#!/usr/bin/env node
/**
 * Dependency audit gate that cannot be fooled by a degraded advisory service.
 *
 * WHY THIS DOES NOT JUST CALL `pnpm audit`
 * ----------------------------------------
 * `pnpm audit` is not trustworthy when npm's advisory service misbehaves, and it
 * misbehaves in both directions. Measured against the 2026-09-04 incident:
 *
 *   - `pnpm audit --json` exits 0 and prints
 *     `{"advisories":{},"metadata":{"vulnerabilities":{"high":0,...}}}`.
 *   - `pnpm audit --audit-level=high` exits 0 and prints
 *     "No known vulnerabilities found" when the service answers HTTP 503.
 *   - The same command exits 1 on a socket timeout, which is indistinguishable
 *     from a genuine high-severity finding.
 *
 * So it reports CLEAN when it has checked nothing, and reports what looks like a
 * finding when it has merely failed to connect. A gate built on its exit code is
 * either a false sense of security or a merge blocker, depending on which way
 * npm happens to be failing that hour.
 *
 * HOW THIS IS DIFFERENT
 * ---------------------
 * We query the advisory service ourselves and include a canary in THE SAME
 * REQUEST as the real query: a package version with a permanent, well-known
 * advisory. If the response does not flag the canary, that response is not
 * trustworthy — whether it arrived as 503, as an empty body, or as a 200 with a
 * degraded dataset — and its silence about everything else means nothing.
 *
 * A canary sent as a separate probe would not be enough. The service flaps, so
 * one request can succeed while the next is degraded. Riding along in the same
 * request is what makes a "clean" answer provable.
 *
 * Version matching is done by the registry, not here. We send name -> versions
 * and read back the advisories it says apply. This gate adds trust verification,
 * it does not reimplement vulnerability matching.
 *
 * THREE OUTCOMES, NEVER CONFLATED
 * -------------------------------
 *   CLEAN         trustworthy response, nothing at or above threshold  -> exit 0
 *   VULNERABLE    trustworthy response, findings at or above threshold -> exit 1
 *   UNDETERMINED  no trustworthy response after retries                -> see below
 *
 * UNDETERMINED claims neither safety nor danger. By default it warns loudly and
 * exits 0: this repo's exposure to the same database is independently and
 * continuously covered by Dependabot, which does not use this endpoint, so
 * blocking every merge on a third-party outage buys no security. Set
 * `AUDIT_REQUIRE_VERDICT=1` to fail closed instead.
 *
 * Usage: node scripts/audit.mjs [--audit-level=high] [--lockfile=pnpm-lock.yaml]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const yaml = require_('yaml')

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical']

// lodash 4.17.20 carries CVE-2021-23337 (command injection, high). Published
// advisories are not retracted, so any healthy response flags this version.
const CANARY = { name: 'lodash', version: '4.17.20' }

const ENDPOINT =
  process.env.AUDIT_CANARY_URL ??
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

const RETRIES = Number(process.env.AUDIT_RETRIES ?? 5)
const BASE_DELAY_MS = Number(process.env.AUDIT_BASE_DELAY_MS ?? 2000)
const TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? 20000)

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const level = arg('audit-level', 'high')
const lockfilePath = arg('lockfile', 'pnpm-lock.yaml')

if (!LEVELS.includes(level)) {
  fail(`unknown --audit-level=${level}; expected one of ${LEVELS.join(', ')}`)
}
const threshold = LEVELS.indexOf(level)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  console.error(`audit gate: ${message}`)
  process.exit(1)
}

/** GitHub Actions annotation, plain text elsewhere. */
function warn(message) {
  console.error(
    process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`,
  )
}

function undetermined(reason) {
  const message =
    `dependency audit UNDETERMINED — ${reason}. This is NOT a clean result: no ` +
    `vulnerability check was completed. Dependabot covers the same advisory ` +
    `database independently.`
  if (process.env.AUDIT_REQUIRE_VERDICT === '1') {
    fail(`${message} AUDIT_REQUIRE_VERDICT=1 set.`)
  }
  warn(message)
  process.exit(0)
}

/**
 * Every resolved package in the workspace, as name -> Set(versions).
 * pnpm lockfile v9 keys look like `name@version` or
 * `@scope/name@version(peer@1.2.3)`; the parenthetical is a peer-resolution
 * suffix and is not part of the version.
 */
function readInstalledPackages(path) {
  let lock
  try {
    lock = yaml.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`could not read lockfile ${path}: ${error?.message ?? error}`)
  }
  const keys = Object.keys(lock?.packages ?? {})
  if (keys.length === 0)
    fail(`lockfile ${path} lists no packages; refusing to report clean`)

  const packages = new Map()
  for (const rawKey of keys) {
    const key = rawKey.split('(')[0]
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    const name = key.slice(0, at)
    const version = key.slice(at + 1)
    if (!name || !version) continue
    if (!packages.has(name)) packages.set(name, new Set())
    packages.get(name).add(version)
  }
  return packages
}

/**
 * One bulk query, with the canary folded in. Returns the advisory map only if
 * the canary came back flagged, otherwise null meaning "not trustworthy".
 */
async function queryWithCanary(payload) {
  const body = {
    ...payload,
    [CANARY.name]: [...new Set([...(payload[CANARY.name] ?? []), CANARY.version])],
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    warn(`advisory service returned HTTP ${response.status}`)
    return null
  }

  const data = await response.json()
  const canaryHits = data?.[CANARY.name]
  const canaryFlagged =
    Array.isArray(canaryHits) && canaryHits.some((a) => Boolean(a?.severity))

  if (!canaryFlagged) {
    warn(
      `advisory service did not flag the canary ${CANARY.name}@${CANARY.version}; ` +
        `treating this response as untrustworthy rather than clean`,
    )
    return null
  }
  return data
}

/**
 * Production-only closure, for repos whose policy is that a dev-only advisory
 * never reaches a consumer. Uses pnpm's own resolution rather than trying to
 * re-derive prod reachability from the lockfile by hand.
 */
async function readProductionPackages() {
  const { spawn } = await import('node:child_process')
  const json = await new Promise((resolve) => {
    const child = spawn('pnpm', ['ls', '-r', '--prod', '--depth', 'Infinity', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? out : null))
  })
  if (!json) fail('could not enumerate production dependencies via `pnpm ls`')

  let importers
  try {
    importers = JSON.parse(json)
  } catch (error) {
    fail(`could not parse \`pnpm ls\` output: ${error?.message ?? error}`)
  }

  const packages = new Map()
  const visit = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      const version = info?.version
      if (typeof version === 'string' && version.length > 0) {
        if (!packages.has(name)) packages.set(name, new Set())
        packages.get(name).add(version)
      }
      if (info?.dependencies) visit(info.dependencies)
    }
  }
  for (const importer of Array.isArray(importers) ? importers : []) {
    visit(importer?.dependencies)
    visit(importer?.optionalDependencies)
  }
  if (packages.size === 0) {
    fail('`pnpm ls --prod` reported no production packages; refusing to report clean')
  }
  return packages
}

const installed = args.includes('--prod')
  ? await readProductionPackages()
  : readInstalledPackages(lockfilePath)
const payload = Object.fromEntries(
  [...installed].map(([name, versions]) => [name, [...versions]]),
)

let advisories = null
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  try {
    advisories = await queryWithCanary(payload)
    if (advisories) break
  } catch (error) {
    warn(`advisory query failed: ${error?.message ?? error}`)
  }
  if (attempt < RETRIES) {
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1)
    console.error(`audit gate: retrying in ${delay}ms (${attempt}/${RETRIES})`)
    await sleep(delay)
  }
}

if (!advisories) {
  undetermined(
    `npm's advisory service returned no trustworthy response after ${RETRIES} attempts`,
  )
}

// The canary is ours, not a finding in this workspace.
const canaryIsReal = installed.get(CANARY.name)?.has(CANARY.version) ?? false
if (!canaryIsReal) delete advisories[CANARY.name]

const findings = []
for (const [name, list] of Object.entries(advisories)) {
  for (const advisory of list ?? []) {
    const severity = String(advisory?.severity ?? '').toLowerCase()
    const rank = LEVELS.indexOf(severity)
    if (rank >= threshold) {
      findings.push({
        name,
        severity,
        title: advisory?.title ?? '(untitled)',
        url: advisory?.url,
      })
    }
  }
}

if (findings.length > 0) {
  console.error(
    `audit gate: VULNERABLE — ${findings.length} finding(s) at or above "${level}":`,
  )
  for (const f of findings) {
    console.error(
      `  ${f.severity.padEnd(8)} ${f.name}  ${f.title}${f.url ? `\n           ${f.url}` : ''}`,
    )
  }
  process.exit(1)
}

console.log(
  `audit gate: CLEAN — ${installed.size} packages checked against a canary-verified ` +
    `response, nothing at or above "${level}".`,
)
