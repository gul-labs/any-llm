#!/usr/bin/env node
/**
 * recapture-fixtures.mjs — MANUAL dev tool, NEVER run in CI.
 *
 * The files under `packages/xai/src/__fixtures__/` are live captures. They prove the
 * adapter handled the API as of the capture date, not as of today. This script repeats
 * a small set of those captures against the live API, redacts the result, and diffs it
 * against the recorded fixture, so provider drift shows up as a reviewable change.
 *
 *   node scripts/recapture-fixtures.mjs --list
 *   node scripts/recapture-fixtures.mjs --dry-run [--only 02,14]
 *   XAI_API_KEY=... node scripts/recapture-fixtures.mjs [--only 02,14] [--write]
 *
 * Needs the packages built (`pnpm -r build`): it reuses core's `redactSecrets`.
 *
 * COST: the probes below send a handful of tiny requests (a one-line prompt, three
 * error requests, one free listing); a run costs well under one US cent. Use a
 * key you are happy to spend on.
 *
 * Safety:
 *   - It refuses to run when `CI` or `GITHUB_ACTIONS` is set, and without the key in
 *     `XAI_API_KEY`. `--list` and `--dry-run` make no request and need no key.
 *   - The key is read from the environment only. It is never printed or written: every
 *     captured string passes through core's secret redaction, the exact key value is
 *     replaced, headers are an allow-list, and a capture that still contains the key
 *     aborts the run.
 *   - A run writes only to `.recapture/` (gitignored) unless `--write` is given, which
 *     overwrites the fixtures that drifted so `git diff` shows the drift.
 *   - A response that is not what the probe expects is a FAILURE, never a capture: a
 *     rate limit (429, 408), a server error (5xx), a rejected key where the probe sends
 *     the real one, an error body where a success is expected, a thrown `fetch` or a
 *     request that exceeds the timeout. The run stops at the first failure, writes no
 *     fixture, and exits 1. With `--write`, every probe is staged first and the fixtures
 *     are written only when all probes succeeded.
 *
 * Exit codes: 0 no drift (or the drift was written), 1 a probe failed, 2 refused or bad
 * arguments, 3 drift found and `--write` not given.
 *
 * Which fixtures: only those whose request is fully known from the fixture and the
 * repository (listed in `PROBES`). Most older fixtures do not record their request and
 * cannot be replayed; a new fixture should record it, and gets a probe here.
 *
 * @module
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_DIR = join(root, 'packages', 'xai', 'src', '__fixtures__')
const OUT_DIR = join(root, '.recapture')
const BASE_URL = 'https://api.x.ai/v1'
const KEY_ENV = 'XAI_API_KEY'
/** One request, including reading its body, may take this long. */
const REQUEST_TIMEOUT_MS = 60_000

/** Response headers worth keeping; everything else is dropped. */
const HEADER_ALLOW = /^(content-type|retry-after|x-ratelimit-.+|x-request-id)$/i

/**
 * Paths whose value changes on every call (ids, times, text, counts, cache state).
 * A change there is not drift; a change in shape, status or any other value is.
 */
const VOLATILE_PATH =
  /(^|\.)(id|created|created_at|completed_at|x-request-id|x-ratelimit-[a-z-]+|text|content|string_token|.*_tokens|total_tokens|.*_ticks|.*_id|captured_at)$|\.summary\[\d+\]\.text$|token_ids\[\d+\]/

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Each probe repeats one recorded request. `run` gets `{ call, recorded }` (the recorded
 * fixture) and returns the fixture value (already in the fixture's own shape). Every
 * `call` states what response it expects (`expect`): `'ok'` (the default) a 2xx with no
 * error body, `'client-error'` a 4xx refusal of the request itself, `'key-rejected'` the
 * rejection of the deliberately invalid key. Anything else makes `call` throw a
 * {@link CaptureFailure}.
 */
const PROBES = [
  {
    id: '02',
    fixture: '02-responses-minimal.json',
    describes: 'grok-4.5, one-line prompt, max_output_tokens 200 (status, headers, body)',
    async run({ call }) {
      return call('POST', '/responses', {
        model: 'grok-4.5',
        input: 'Say hi',
        max_output_tokens: 200,
      })
    },
  },
  {
    id: '09',
    fixture: '09-error-taxonomy.json',
    describes: 'three error responses: unknown model, malformed body, invalid key',
    async run({ call }) {
      const only = ({ status, body }) => ({ status, body })
      return {
        nonexistent_model: only(
          await call(
            'POST',
            '/responses',
            { model: 'grok-99', input: 'Say hi' },
            { expect: 'client-error' },
          ),
        ),
        malformed_body: only(
          await call('POST', '/responses', { model: 12 }, { expect: 'client-error' }),
        ),
        invalid_api_key: only(
          await call(
            'POST',
            '/responses',
            { model: 'grok-4.5', input: 'Say hi' },
            { key: 'xai-this-key-is-deliberately-invalid', expect: 'key-rejected' },
          ),
        ),
      }
    },
  },
  {
    id: '13',
    fixture: '13-grok-4-6-effort-none.json',
    describes: 'grok-4.6 refuses reasoning.effort "none" (status, body)',
    async run({ call }) {
      const { status, body } = await call(
        'POST',
        '/responses',
        {
          model: 'grok-4.6',
          input: 'Say hi',
          max_output_tokens: 16,
          reasoning: { effort: 'none' },
        },
        { expect: 'client-error' },
      )
      return { status, body }
    },
  },
  {
    id: '14',
    fixture: '14-v1-models-pricing.json',
    describes:
      'GET /v1/models, the grok ids the fixture records, with their published prices (free)',
    async run({ call, recorded }) {
      const { body } = await call('GET', '/models')
      // The ids the fixture holds: a model that disappears shows as a removed path, and one
      // the fixture never had is not a permanent "new path" on every run.
      const wanted = Object.keys(recorded.models ?? {})
      const models = {}
      for (const model of body.data ?? body.models ?? []) {
        if (wanted.includes(model.id)) models[model.id] = model
      }
      return {
        captured_at: new Date().toISOString().slice(0, 10),
        source: 'GET https://api.x.ai/v1/models',
        models,
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Redaction and diff (pure; unit-tested offline)
// ---------------------------------------------------------------------------

/**
 * Redact one captured value: secret-shaped strings (core's patterns), the exact key
 * value, and for a `{ status, headers, body }` capture all but the allow-listed headers.
 *
 * @param {unknown} value
 * @param {{ key?: string, redactSecrets: (text: string) => string }} deps
 */
export function redactCapture(value, { key, redactSecrets }) {
  const scrub = (text) => {
    let out = redactSecrets(text)
    if (key !== undefined && key.length > 0) out = out.split(key).join('REDACTED')
    return out
  }
  const walk = (v, name) => {
    if (typeof v === 'string') return scrub(v)
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v !== null && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) {
        if (name === 'headers' && !HEADER_ALLOW.test(k)) continue
        out[scrub(k)] = walk(x, k)
      }
      return out
    }
    return v
  }
  const redacted = walk(value)
  if (key !== undefined && key.length > 0 && JSON.stringify(redacted).includes(key)) {
    throw new Error('the capture still contains the API key after redaction; aborting')
  }
  return redacted
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

/**
 * The drift between a recorded fixture and a fresh capture, as printable lines.
 * `+` a path that is new, `-` one that is gone, `~` a changed type, status or stable
 * value. Volatile paths (ids, times, text, token counts) are compared by type only.
 *
 * @returns {string[]}
 */
export function diffCapture(recorded, fresh) {
  const lines = []
  const walk = (a, b, path) => {
    if (kind(a) !== kind(b)) {
      lines.push(`~ ${path || '(root)'}: type ${kind(a)} -> ${kind(b)}`)
      return
    }
    if (Array.isArray(a)) {
      if (a.length !== b.length && !VOLATILE_PATH.test(path)) {
        lines.push(`~ ${path}: ${a.length} items -> ${b.length}`)
      }
      for (let i = 0; i < Math.min(a.length, b.length); i += 1)
        walk(a[i], b[i], `${path}[${i}]`)
      return
    }
    if (a !== null && typeof a === 'object') {
      for (const k of Object.keys(a)) {
        const p = path === '' ? k : `${path}.${k}`
        if (!(k in b)) lines.push(`- ${p}`)
        else walk(a[k], b[k], p)
      }
      for (const k of Object.keys(b)) {
        if (!(k in a)) lines.push(`+ ${path === '' ? k : `${path}.${k}`}`)
      }
      return
    }
    if (a !== b && !VOLATILE_PATH.test(path)) {
      lines.push(`~ ${path || '(root)'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
    }
  }
  walk(recorded, fresh, '')
  return lines
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** A probe got a response that must not become a fixture. */
export class CaptureFailure extends Error {}

const errorShaped = (body) =>
  body !== null &&
  typeof body === 'object' &&
  (('error' in body && body.error !== null && body.error !== undefined) ||
    body.status === 'failed')

/**
 * Why a response must not become a fixture, or `undefined` when it is what the probe
 * expected. A rate limit, a timeout status and any 5xx are never a capture, whatever the
 * probe expects.
 *
 * @param {{ status: number, body: unknown }} response
 * @param {'ok' | 'client-error' | 'key-rejected'} expect
 * @param {{ realKey: boolean }} [opts] `realKey`: the request carried the real key
 * @returns {string | undefined}
 */
export function judgeResponse({ status, body }, expect, { realKey = true } = {}) {
  if (status === 429 || status === 408)
    return `HTTP ${status}: rate limited or timed out; try again later`
  if (status >= 500) return `HTTP ${status}: a server error`
  if (expect === 'ok') {
    if (status < 200 || status > 299) return `HTTP ${status}, expected a 2xx`
    if (errorShaped(body)) return 'a 2xx response with an error body'
    return undefined
  }
  if (expect === 'key-rejected') {
    return [400, 401, 403].includes(status)
      ? undefined
      : `HTTP ${status}, expected the invalid key to be rejected`
  }
  // 'client-error'
  if (status < 400) return `HTTP ${status}, expected the request to be refused`
  const message = JSON.stringify(body ?? '')
  if (
    realKey &&
    (status === 401 ||
      status === 403 ||
      /incorrect api key|invalid api key|api key (is )?(invalid|expired|revoked)/i.test(
        message,
      ))
  ) {
    return `HTTP ${status}: the key was rejected (expired, revoked or out of credit?)`
  }
  return undefined
}

function parseArgs(argv) {
  const args = { list: false, dryRun: false, write: false, only: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--list') args.list = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--write') args.write = true
    else if (a === '--only') {
      args.only = (argv[(i += 1)] ?? '').split(',').filter(Boolean)
      if (args.only.length === 0)
        throw new Error('--only needs a comma-separated list of probe ids (see --list)')
    } else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/**
 * Run the tool. Everything it touches is a parameter so a test can run it against a
 * stubbed `fetch` and temporary directories; the command line passes the defaults.
 *
 * @returns {Promise<number>} the exit code
 */
export async function recapture({
  argv,
  env,
  fetch: fetchImpl = globalThis.fetch,
  fixtureDir = FIXTURE_DIR,
  outDir = OUT_DIR,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = console.log,
  logError = console.error,
}) {
  const refuse = (message) => {
    logError(`recapture-fixtures: ${message}`)
    return 2
  }
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    return refuse(error.message)
  }
  const selected =
    args.only === undefined ? PROBES : PROBES.filter((p) => args.only.includes(p.id))
  const unknown = (args.only ?? []).filter((id) => !PROBES.some((p) => p.id === id))
  if (unknown.length > 0)
    return refuse(`no probe with id ${unknown.join(', ')} (see --list)`)

  if (args.list || args.dryRun) {
    for (const p of selected) {
      log(`${p.id}  ${p.fixture}\n    ${p.describes}`)
    }
    if (args.dryRun) log(`\n${selected.length} probe(s) would run against ${BASE_URL}`)
    return 0
  }

  if (env['CI'] || env['GITHUB_ACTIONS']) {
    return refuse('this script makes billed live calls and never runs in CI')
  }
  const key = env[KEY_ENV]
  if (key === undefined || key === '') {
    return refuse(`${KEY_ENV} is not set (use --list or --dry-run to see what would run)`)
  }

  const { redactSecrets } = await import('@gullabs/core')
  const call = async (method, path, body, opts = {}) => {
    let res
    let text
    try {
      res = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.key ?? key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await res.text()
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new CaptureFailure(
        `${method} ${path}: ${timedOut ? `no response within ${timeoutMs} ms` : `the request failed (${error?.cause?.code ?? error?.message ?? error})`}`,
      )
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { text }
    }
    const response = {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed,
    }
    const problem = judgeResponse(response, opts.expect ?? 'ok', {
      realKey: opts.key === undefined,
    })
    if (problem !== undefined) throw new CaptureFailure(`${method} ${path}: ${problem}`)
    return response
  }

  // Stage every probe first: nothing is written to a fixture until all of them succeeded.
  const staged = []
  let failure
  for (const p of selected) {
    log(`\n${p.id}  ${p.fixture}`)
    try {
      const recorded = JSON.parse(readFileSync(join(fixtureDir, p.fixture), 'utf8'))
      const capture = redactCapture(await p.run({ call, recorded }), {
        key,
        redactSecrets,
      })
      const drift = diffCapture(recorded, capture)
      staged.push({ probe: p, text: `${JSON.stringify(capture, null, 2)}\n`, drift })
      if (drift.length === 0) log('  no drift')
      else for (const line of drift) log(`  ${line}`)
    } catch (error) {
      failure = { probe: p, message: error.message }
      break
    }
  }
  if (failure !== undefined) {
    logError(
      `\nrecapture-fixtures: probe ${failure.probe.id} failed: ${failure.message}\n` +
        `Nothing was written to the fixtures.${staged.length > 0 ? ' (Captures of the probes that finished are in ' + outDir + '.)' : ''}`,
    )
    writeCaptures(outDir, staged)
    return 1
  }
  writeCaptures(outDir, staged)

  const drifted = staged.filter((s) => s.drift.length > 0)
  log(
    `\n${drifted.length} of ${staged.length} fixture(s) drifted. Captures are in ${outDir}.`,
  )
  if (drifted.length === 0) return 0
  if (!args.write) {
    log('Fixtures untouched; re-run with --write to overwrite the drifted ones.')
    return 3
  }
  const temps = []
  try {
    for (const { probe, text } of drifted) {
      const tmp = join(fixtureDir, `.${probe.fixture}.tmp`)
      writeFileSync(tmp, text)
      temps.push([tmp, join(fixtureDir, probe.fixture)])
    }
  } catch (error) {
    for (const [tmp] of temps) rmSync(tmp, { force: true })
    logError(
      `recapture-fixtures: could not stage the fixtures (${error.message}); none written`,
    )
    return 1
  }
  for (const [tmp, final] of temps) renameSync(tmp, final)
  log(`Overwrote ${drifted.map((s) => s.probe.fixture).join(', ')} (review git diff).`)
  return 0
}

function writeCaptures(outDir, staged) {
  if (staged.length === 0) return
  mkdirSync(outDir, { recursive: true })
  for (const { probe, text } of staged) writeFileSync(join(outDir, probe.fixture), text)
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await recapture({ argv: process.argv.slice(2), env: process.env })
}
