#!/usr/bin/env node
/**
 * Offline self-test for scripts/recapture-fixtures.mjs: it must refuse to run without
 * the key or in CI, never print or keep the key, and report drift (and only drift).
 *
 * Usage: node scripts/recapture-fixtures.test.mjs   (needs `pnpm -r build` first)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactSecrets } from '@gullabs/core'

import {
  diffCapture,
  judgeResponse,
  recapture,
  redactCapture,
} from './recapture-fixtures.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'recapture-fixtures.mjs')
const run = (args, env) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    // No inherited XAI_API_KEY / CI: each case sets exactly what it tests.
    env: { PATH: process.env.PATH, ...env },
  })

// Refusals: nothing is sent, the exit code is 2, the key is never echoed.
const noKey = run([], {})
assert.equal(noKey.status, 2)
assert.match(noKey.stderr, /XAI_API_KEY is not set/)

const secret = 'xai-0123456789abcdefghijklmnopqrstuvwxyz0123456789'
for (const ci of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
  const inCi = run([], { XAI_API_KEY: secret, ...ci })
  assert.equal(inCi.status, 2)
  assert.match(inCi.stderr, /never runs in CI/)
  assert.ok(!inCi.stdout.includes(secret) && !inCi.stderr.includes(secret))
}
assert.equal(run(['--only', 'nope'], { XAI_API_KEY: secret }).status, 2)
assert.equal(run(['--bogus'], {}).status, 2)
// `--only` with no list is an error, not "0 of 0 drifted".
const onlyEmpty = run(['--only'], { XAI_API_KEY: secret })
assert.equal(onlyEmpty.status, 2)
assert.match(onlyEmpty.stderr, /--only needs/)

// --list and --dry-run make no request and need no key.
const list = run(['--list'], {})
assert.equal(list.status, 0, list.stderr)
assert.match(list.stdout, /02-responses-minimal\.json/)
const dry = run(['--dry-run', '--only', '14'], {})
assert.equal(dry.status, 0, dry.stderr)
assert.match(dry.stdout, /1 probe\(s\) would run/)

// Redaction: the key (even when it is not secret-shaped), Bearer tokens, other headers.
const key = 'not-shaped-like-a-key-9f8e7d'
const capture = {
  status: 401,
  headers: {
    authorization: `Bearer ${key}`,
    'set-cookie': 'session=abc',
    'content-type': 'application/json',
    'x-ratelimit-limit-requests': '41000',
  },
  body: { error: `Incorrect API key provided: ${key}`, nested: [`echo ${secret}`] },
}
const clean = redactCapture(capture, { key, redactSecrets })
const dump = JSON.stringify(clean)
assert.ok(!dump.includes(key) && !dump.includes(secret), dump)
assert.deepEqual(Object.keys(clean.headers).sort(), [
  'content-type',
  'x-ratelimit-limit-requests',
])
assert.equal(clean.status, 401)

// Diff: volatile values (ids, text, counts, times) are not drift; shape, status and
// stable values are.
const recorded = {
  status: 200,
  body: {
    id: 'a',
    created_at: 1,
    model: 'grok-4.5',
    output: [{ type: 'message', text: 'Hi!' }],
    usage: { input_tokens: 10, cost_in_usd_ticks: 5 },
  },
}
const same = structuredClone(recorded)
same.body.id = 'b'
same.body.created_at = 2
same.body.output[0].text = 'Hello there'
same.body.usage = { input_tokens: 99, cost_in_usd_ticks: 7 }
assert.deepEqual(diffCapture(recorded, same), [])

const drifted = structuredClone(recorded)
drifted.status = 400
drifted.body.model = 'grok-4.6'
delete drifted.body.usage.cost_in_usd_ticks
drifted.body.service_tier = 'default'
drifted.body.id = 7
assert.deepEqual(diffCapture(recorded, drifted).sort(), [
  '+ body.service_tier',
  '- body.usage.cost_in_usd_ticks',
  '~ body.id: type string -> number',
  '~ body.model: "grok-4.5" -> "grok-4.6"',
  '~ status: 200 -> 400',
])

// ---------------------------------------------------------------------------
// What may become a fixture: only the response the probe expects.
// ---------------------------------------------------------------------------

const judge = (status, body, expect, opts) =>
  judgeResponse({ status, body }, expect, opts)
assert.equal(judge(200, { id: 'a' }, 'ok'), undefined)
assert.match(judge(429, { error: 'slow' }, 'ok'), /429/)
assert.match(judge(429, { error: 'slow' }, 'client-error'), /rate limited/)
assert.match(judge(408, {}, 'client-error'), /408/)
assert.match(judge(503, {}, 'ok'), /server error/)
assert.match(judge(500, {}, 'key-rejected'), /server error/)
assert.match(judge(400, { error: 'bad' }, 'ok'), /expected a 2xx/)
assert.match(judge(200, { code: 'x', error: 'bad' }, 'ok'), /error body/)
assert.match(judge(200, { status: 'failed' }, 'ok'), /error body/)
assert.equal(judge(200, { error: null }, 'ok'), undefined)
assert.equal(judge(400, { error: 'Model not found' }, 'client-error'), undefined)
assert.equal(judge(422, { error: 'x' }, 'client-error'), undefined)
assert.match(judge(200, {}, 'client-error'), /refused/)
// A rejected real key is not a capture of "the API refuses this request".
assert.match(judge(401, { error: 'x' }, 'client-error'), /key was rejected/)
assert.match(judge(403, { error: 'x' }, 'client-error'), /key was rejected/)
assert.match(
  judge(400, { error: 'Incorrect API key provided.' }, 'client-error'),
  /key was rejected/,
)
// ... but the deliberately invalid key is expected to be rejected, and only with a 4xx.
assert.equal(judge(400, { error: 'Incorrect API key' }, 'key-rejected'), undefined)
assert.equal(judge(401, {}, 'key-rejected'), undefined)
assert.match(judge(200, {}, 'key-rejected'), /invalid key/)
assert.equal(
  judge(400, { error: 'Incorrect API key' }, 'client-error', { realKey: false }),
  undefined,
)

// ---------------------------------------------------------------------------
// recapture() against a stubbed fetch, in temporary directories.
// ---------------------------------------------------------------------------

const realFixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'xai',
  'src',
  '__fixtures__',
)
const readJson = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const recordedIn = (name) => readJson(realFixtures, name)

/** What the live API returned when the fixtures were recorded, as a fetch stub. */
function liveStub(overrides = {}) {
  const calls = []
  // A body-only fixture needs no headers; fixture 02 records headers and no content-type,
  // so the one `Response` adds for a string body is removed again.
  const respond = (status, body, headers) => {
    const res = new Response(JSON.stringify(body), { status, headers })
    if (headers !== undefined) res.headers.delete('content-type')
    return res
  }
  const fetchStub = async (url, init = {}) => {
    const path = new URL(url).pathname
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    const invalidKey =
      init.headers.authorization === 'Bearer xai-this-key-is-deliberately-invalid'
    const id = !path.endsWith('/models')
      ? invalidKey
        ? '09-invalid'
        : body.model === 'grok-4.5'
          ? '02'
          : body.model === 'grok-4.6'
            ? '13'
            : body.model === 'grok-99'
              ? '09-model'
              : '09-malformed'
      : '14'
    calls.push(id)
    if (overrides[id] !== undefined) return overrides[id](init)
    const taxonomy = recordedIn('09-error-taxonomy.json')
    switch (id) {
      case '02': {
        const { status, headers, body: out } = recordedIn('02-responses-minimal.json')
        return respond(status, out, headers)
      }
      case '09-model':
        return respond(taxonomy.nonexistent_model.status, taxonomy.nonexistent_model.body)
      case '09-malformed':
        return respond(taxonomy.malformed_body.status, taxonomy.malformed_body.body)
      case '09-invalid':
        return respond(taxonomy.invalid_api_key.status, taxonomy.invalid_api_key.body)
      case '13': {
        const { status, body: out } = recordedIn('13-grok-4-6-effort-none.json')
        return respond(status, out)
      }
      default:
        return respond(200, {
          data: Object.values(recordedIn('14-v1-models-pricing.json').models),
        })
    }
  }
  return { fetch: fetchStub, calls }
}

async function scenario(argv, overrides, { timeoutMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recapture-test-'))
  const fixtureDir = join(dir, 'fixtures')
  const outDir = join(dir, 'out')
  cpSync(realFixtures, fixtureDir, { recursive: true })
  const stub = liveStub(overrides)
  const out = []
  const err = []
  try {
    const code = await recapture({
      argv,
      env: { XAI_API_KEY: secret },
      fetch: stub.fetch,
      fixtureDir,
      outDir,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      log: (line) => out.push(line),
      logError: (line) => err.push(line),
    })
    const text = `${out.join('\n')}\n${err.join('\n')}`
    assert.ok(!text.includes(secret), 'the key is never printed')
    // Read everything before the directory is removed.
    const names = readdirSync(fixtureDir)
    const texts = Object.fromEntries(
      names.map((name) => [name, readFileSync(join(fixtureDir, name), 'utf8')]),
    )
    const untouched =
      names.length === readdirSync(realFixtures).length &&
      names.every(
        (name) => texts[name] === readFileSync(join(realFixtures, name), 'utf8'),
      )
    const captures = existsSync(outDir) ? readdirSync(outDir) : []
    return {
      code,
      text,
      stderr: err.join('\n'),
      calls: stub.calls,
      fixture: (name) => texts[name],
      untouched: () => untouched,
      hasCapture: (name) => captures.includes(name),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A world identical to the recorded one: no drift, exit 0, nothing written to fixtures.
{
  const clean = await scenario(['--write'], {})
  assert.equal(clean.code, 0, clean.text)
  assert.match(clean.text, /0 of 4 fixture\(s\) drifted/)
  assert.ok(clean.untouched())
  assert.ok(clean.hasCapture('02-responses-minimal.json'))
}

// Real drift: without --write it is reported (exit 3) and nothing is written; with
// --write only the drifted fixture is overwritten, with no temp file left behind.
{
  const moved = {
    13: () =>
      new Response(JSON.stringify({ code: 'invalid-argument', error: 'A new message' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  }
  const report = await scenario(['--only', '13'], moved)
  assert.equal(report.code, 3, report.text)
  assert.match(report.text, /~ body\.error/)
  assert.ok(report.untouched())

  const written = await scenario(['--only', '13', '--write'], moved)
  assert.equal(written.code, 0, written.text)
  assert.match(written.fixture('13-grok-4-6-effort-none.json'), /A new message/)
  assert.ok(!written.untouched())
}

// A 429 is a failure: nothing is written, the exit code is 1, the message says why.
{
  const limited = () =>
    new Response(JSON.stringify({ code: 'x', error: 'Rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
  const one = await scenario(['--only', '13', '--write'], { 13: limited })
  assert.equal(one.code, 1, one.text)
  assert.match(one.stderr, /probe 13 failed.*429/)
  assert.match(one.stderr, /Nothing was written/)
  assert.ok(one.untouched(), 'the fixture was not clobbered with the 429')

  const all = await scenario(['--write'], { '02': limited })
  assert.equal(all.code, 1, all.text)
  assert.ok(all.untouched())
  assert.deepEqual(all.calls, ['02'], 'the run stops at the first failure')
  assert.ok(!all.hasCapture('02-responses-minimal.json'))
}

// A fetch that throws is a failure with the cause, not a crash and not a write.
{
  const thrown = await scenario(['--only', '13', '--write'], {
    13: () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    },
  })
  assert.equal(thrown.code, 1, thrown.text)
  assert.match(thrown.stderr, /the request failed \(ECONNRESET\)/)
  assert.ok(thrown.untouched())
}

// A request that never answers times out.
{
  const hung = await scenario(
    ['--only', '13', '--write'],
    {
      13: (init) =>
        new Promise((_, reject) => {
          // AbortSignal.timeout() does not keep the process alive; a real socket would.
          const alive = setInterval(() => {}, 1000)
          init.signal.addEventListener('abort', () => {
            clearInterval(alive)
            reject(init.signal.reason)
          })
        }),
    },
    { timeoutMs: 25 },
  )
  assert.equal(hung.code, 1, hung.text)
  assert.match(hung.stderr, /no response within 25 ms/)
  assert.ok(hung.untouched())
}

// A failure mid-run leaves EARLIER fixtures alone too, even when they drifted: all
// probes are staged and written only if every one succeeded.
{
  const earlyDrift = {
    '02': () => {
      const { status, headers, body } = recordedIn('02-responses-minimal.json')
      return new Response(JSON.stringify({ ...body, model: 'grok-9', brand_new: true }), {
        status,
        headers,
      })
    },
    13: () => new Response('{"error":"upstream"}', { status: 503 }),
  }
  const mid = await scenario(['--write'], earlyDrift)
  assert.equal(mid.code, 1, mid.text)
  assert.match(mid.text, /\+ body\.brand_new/, 'the drift of probe 02 was seen')
  assert.match(mid.stderr, /probe 13 failed.*503/)
  assert.ok(mid.untouched(), 'probe 02 was not written although it drifted')
  assert.deepEqual(mid.calls.slice(-1), ['13'])
}

// Other responses that must not become a fixture: an expired key on a normal request,
// and an error body where a success is expected.
{
  const expired = await scenario(['--only', '13', '--write'], {
    13: () =>
      new Response(JSON.stringify({ code: 'x', error: 'Incorrect API key provided.' }), {
        status: 400,
      }),
  })
  assert.equal(expired.code, 1, expired.text)
  assert.match(expired.stderr, /key was rejected/)
  assert.ok(expired.untouched())

  const errorBody = await scenario(['--only', '02', '--write'], {
    '02': () => new Response(JSON.stringify({ error: 'overloaded' }), { status: 200 }),
  })
  assert.equal(errorBody.code, 1, errorBody.text)
  assert.match(errorBody.stderr, /error body/)
  assert.ok(errorBody.untouched())
}

// Probe 14 follows the ids the fixture records: no permanent "+ models.grok-4.7".
{
  const clean14 = await scenario(['--only', '14'], {
    14: () =>
      new Response(
        JSON.stringify({
          data: [
            ...Object.values(recordedIn('14-v1-models-pricing.json').models),
            { id: 'grok-4.7', object: 'model' },
          ],
        }),
        { status: 200 },
      ),
  })
  assert.equal(clean14.code, 0, clean14.text)
  assert.doesNotMatch(clean14.text, /grok-4\.7/)
}
console.log('recapture-fixtures: ok')
