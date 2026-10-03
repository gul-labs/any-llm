#!/usr/bin/env node
/**
 * Offline self-test for scripts/recapture-fixtures.mjs: it must refuse to run without
 * the key or in CI, never print or keep the key, and report drift (and only drift).
 *
 * Usage: node scripts/recapture-fixtures.test.mjs   (needs `pnpm -r build` first)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { redactSecrets } from '@gullabs/core'

import { diffCapture, redactCapture } from './recapture-fixtures.mjs'

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
console.log('recapture-fixtures: ok')
