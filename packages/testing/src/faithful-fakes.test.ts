/**
 * R8 audit fixes for the test package: provider-shaped errors reach the fakes
 * classified as the real adapters classify them, `FakeClient` rejects only
 * with `LlmError`, `FakeClock` works detached and rejects bad input,
 * concurrent delayed `FakeAdapter` calls each take their own entry, the file
 * store admits what the real one admits, and `fakeLlmResult` does not claim
 * a price it was not given.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  classifyError,
  createClient,
  createModelRegistry,
  LlmError,
  retryMiddleware,
  type AdapterResult,
  type LlmRequest,
} from '@gullabs/core'
import { classifyGoogleError } from '@gullabs/google'
import { classifyXaiError } from '@gullabs/xai'
import {
  FakeAdapter,
  FakeClient,
  FakeClock,
  FakeGoogleCacheStore,
  FakeGoogleFileStore,
  RecordingSink,
  SignalAwareFakeAdapter,
  fakeHttpError,
  fakeLlmResult,
  fakeNetworkError,
  fakeProviderError,
  type GoogleErrorScenario,
  type XaiErrorScenario,
} from './index.js'
import { llmErrorOptionsOf } from '@gullabs/core'
import { adopt } from './provider-errors.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'm',
  warnings: [],
}

const request = (provider: string): LlmRequest => ({
  provider,
  model: 'm',
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
})

function clientFor(provider: string, adapter: FakeAdapter, clock = new FakeClock()) {
  const sink = new RecordingSink()
  const client = createClient({
    adapters: [adapter],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ provider, model: 'm' }),
    ]),
    clock,
    scheduler: clock,
    sink,
    middleware: [
      retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 }, { random: () => 0 }),
    ],
  })
  return { client, clock, sink }
}

async function run(
  provider: string,
  entries: ConstructorParameters<typeof FakeAdapter>[1],
): Promise<{ error?: LlmError; adapter: FakeAdapter }> {
  const adapter = new FakeAdapter(provider, entries)
  const { client, clock } = clientFor(provider, adapter)
  const settled = client.generate(request(provider), { auth: { apiKey: 'k' } }).then(
    () => undefined,
    (e: unknown) => e as LlmError,
  )
  await clock.advanceAsync(120_000)
  const error = await settled
  return { ...(error !== undefined ? { error } : {}), adapter }
}

const FIELDS = [
  'kind',
  'retryable',
  'reason',
  'httpStatus',
  'retryAfterMs',
  'provider',
] as const
const pick = (e: LlmError) => Object.fromEntries(FIELDS.map((f) => [f, e[f]]))

describe('a provider-shaped error thrown by a FakeAdapter is classified as the real adapter classifies it', () => {
  const google: GoogleErrorScenario[] = [
    'invalid-api-key',
    'empty-api-key',
    'stale-cached-content',
    'malformed-cache-name',
    'expired-api-key',
    'per-minute-quota',
    'per-day-quota',
    'capacity-503',
    'retry-info-only',
    'bare-429',
  ]
  const xai: XaiErrorScenario[] = [
    'nonexistent-model',
    'malformed-body',
    'invalid-api-key',
    'safety-check',
    'credits-exhausted-429',
    'credits-exhausted-403',
  ]

  it.each(google)('google %s ends as classifyGoogleError says', async (scenario) => {
    const raw = fakeProviderError('google', scenario)
    const expected = classifyGoogleError(raw)
    // A single entry never succeeds, so the attempts the retry middleware makes
    // all see the same error; the final error is the classified one.
    const { error } = await run('google', [raw])
    expect(error).toBeInstanceOf(LlmError)
    expect(pick(error as LlmError)).toEqual(pick(expected))
  })

  it.each(xai)('xai %s ends as classifyXaiError says', async (scenario) => {
    const raw = fakeProviderError('xai', scenario)
    const expected = classifyXaiError(raw)
    const { error } = await run('xai', [raw])
    expect(error).toBeInstanceOf(LlmError)
    expect(pick(error as LlmError)).toEqual(pick(expected))
  })

  it('a per-day quota stops the retry loop; a per-minute quota is retried with the body delay', async () => {
    const day = await run('google', [fakeProviderError('google', 'per-day-quota'), OK])
    expect(day.error).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'daily_quota',
    })
    expect(day.adapter.calls).toHaveLength(1)

    const minute = await run('google', [
      fakeProviderError('google', 'per-minute-quota'),
      OK,
    ])
    expect(minute.error).toBeUndefined()
    expect(minute.adapter.calls).toHaveLength(2)
  })

  it('exhausted xAI credits stop the retry loop', async () => {
    const out = await run('xai', [fakeProviderError('xai', 'credits-exhausted-429'), OK])
    expect(out.error).toMatchObject({ reason: 'credits_exhausted', retryable: false })
    expect(out.adapter.calls).toHaveLength(1)
  })

  it('a bad API key is invalid_auth, not the HTTP 400 core would call bad_request', async () => {
    const out = await run('google', [fakeProviderError('google', 'invalid-api-key')])
    expect(out.error).toMatchObject({ kind: 'invalid_auth', provider: 'google' })
  })

  it('a SignalAwareFakeAdapter classifies the same way', async () => {
    const clock = new FakeClock()
    const adapter = new SignalAwareFakeAdapter(
      'google',
      fakeProviderError('google', 'per-day-quota'),
      { delayMs: 5 },
    )
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      clock,
      scheduler: clock,
    })
    const settled = client.generate(request('google'), { auth: { apiKey: 'k' } }).then(
      () => undefined,
      (e: unknown) => e,
    )
    await clock.advanceAsync(10)
    expect(await settled).toMatchObject({ reason: 'daily_quota', retryable: false })
  })

  it('an error that is not provider-shaped is left to core, as for any adapter', async () => {
    const out = await run('google', [fakeHttpError(503), OK])
    expect(out.error).toBeUndefined()
    expect(out.adapter.calls).toHaveLength(2)
  })
})

describe('FakeClient rejects only with LlmError', () => {
  const opts = { auth: { apiKey: 'k' } }

  it('a raw error is classified as a real client classifies it', async () => {
    const client = new FakeClient([
      fakeHttpError(503),
      fakeNetworkError(),
      new Error('something odd'),
    ])
    for (const expected of [
      { kind: 'server', retryable: true },
      { kind: 'server', retryable: true },
      { kind: 'unknown' },
    ]) {
      const e = await client.generate(request('google'), opts).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(LlmError)
      expect(e).toMatchObject(expected)
    }
  })

  it('a provider-shaped error arrives classified by the provider classifier', async () => {
    const client = new FakeClient(fakeProviderError('google', 'per-day-quota'))
    const e = await client.generate(request('google'), opts).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(LlmError)
    expect(e).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'daily_quota',
      provider: 'google',
    })
  })

  it('an LlmError passes through unchanged; countTokens answers follow the same rule', async () => {
    const own = new LlmError('x', { kind: 'content_filter', retryable: false })
    const client = new FakeClient(own, { countTokens: [fakeHttpError(429)] })
    expect(await client.generate(request('google'), opts).catch((x: unknown) => x)).toBe(
      own,
    )
    const counted = await client
      .countTokens({ provider: 'google', model: 'm', messages: [] }, opts)
      .catch((x: unknown) => x)
    expect(counted).toBeInstanceOf(LlmError)
    expect(counted).toMatchObject({ kind: 'rate_limited' })
  })

  it('matches core classifyError for a plain error', async () => {
    const raw = fakeHttpError(500)
    const client = new FakeClient(raw)
    const e = (await client
      .generate(request('google'), opts)
      .catch((x: unknown) => x)) as LlmError
    expect(e.kind).toBe(classifyError(raw).kind)
  })
})

describe('FakeClock keeps the Clock and Scheduler contract (this: void)', () => {
  it('now, setTimeout and clearTimeout work detached', () => {
    const clock = new FakeClock(1_000)
    const { now, setTimeout: set, clearTimeout: clear, advance } = clock
    let fired = 0
    const handle = set(() => (fired += 1), 10)
    set(() => (fired += 10), 20)
    clear(handle)
    advance(30)
    expect(fired).toBe(10)
    expect(now()).toBe(1_030)
  })

  it('advance rejects NaN, infinite and negative amounts and leaves the time alone', () => {
    const clock = new FakeClock(100)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      expect(() => clock.advance(bad)).toThrow(RangeError)
    }
    expect(clock.now()).toBe(100)
  })

  it('advanceAsync and set reject bad amounts too', async () => {
    const clock = new FakeClock(100)
    await expect(clock.advanceAsync(Number.NaN)).rejects.toThrow(RangeError)
    await expect(clock.advanceAsync(-1)).rejects.toThrow(RangeError)
    expect(() => clock.set(Number.NaN)).toThrow(RangeError)
    expect(clock.now()).toBe(100)
  })

  it('an advance inside a timer callback never leaves time behind the inner target', () => {
    const clock = new FakeClock(0)
    const seen: number[] = []
    clock.setTimeout(() => {
      seen.push(clock.now())
      clock.advance(1_000)
      seen.push(clock.now())
    }, 10)
    clock.setTimeout(() => seen.push(clock.now()), 50)
    clock.advance(100)
    // The inner advance fires the timer due at 50 on its way to 1010.
    expect(seen).toEqual([10, 50, 1_010])
    expect(clock.now()).toBe(1_010)
  })
})

describe('FakeAdapter with concurrent delayed calls', () => {
  it('each call consumes its own scripted entry, in call order', async () => {
    const a: AdapterResult = { ...OK, text: 'A' }
    const b: AdapterResult = { ...OK, text: 'B' }
    const clock = new FakeClock()
    const adapter = new FakeAdapter('google', [a, b], { delayMs: 100 })
    const ctx = { callId: 'c', clock, scheduler: clock, logger: console } as never
    const first = adapter.run({ ...request('google'), config: {} }, ctx)
    const second = adapter.run({ ...request('google'), config: {} }, ctx)
    await clock.advanceAsync(100)
    expect((await first).text).toBe('A')
    expect((await second).text).toBe('B')
  })
})

describe('FakeGoogleFileStore admits what the real store admits', () => {
  it('refuses a media type the real store refuses, with the same shared rule', async () => {
    const files = new FakeGoogleFileStore()
    await expect(
      files.upload(new Uint8Array([1]), 'application/x-foo'),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      provider: 'google',
    })
    await expect(files.upload(new Uint8Array([1]), '')).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(files.size).toBe(0)
    await expect(
      files.upload(new Uint8Array([1]), 'Image/PNG; charset=binary'),
    ).resolves.toMatchObject({ mimeType: 'Image/PNG; charset=binary' })
    await expect(
      files.upload(new Uint8Array([1]), 'application/pdf'),
    ).resolves.toBeDefined()
  })

  it('failUpload scripts an upload failure, classified like the real store classifies it', async () => {
    const files = new FakeGoogleFileStore({
      failUpload: [fakeProviderError('google', 'per-day-quota')],
    })
    await expect(files.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      kind: 'rate_limited',
      reason: 'daily_quota',
    })
    expect(files.size).toBe(0)
    // The script is spent: the next upload goes through.
    await expect(files.upload(new Uint8Array([1]), 'image/png')).resolves.toBeDefined()
  })
})

describe('FakeGoogleCacheStore mirrors the real store on failure, preflight and coalescing', () => {
  const input = { model: 'gemini-3-pro', ttlSeconds: 600 }

  it('failCreate scripts a create failure, classified; the script is then spent', async () => {
    const caches = new FakeGoogleCacheStore({
      failCreate: [fakeProviderError('google', 'invalid-api-key')],
    })
    await expect(caches.create(input)).rejects.toMatchObject({ kind: 'invalid_auth' })
    expect(caches.size).toBe(0)
    expect(caches.created).toBe(0)
    await expect(caches.create(input)).resolves.toBeDefined()
  })

  it('preflight refuses a create below minTokens before anything is created', async () => {
    const caches = new FakeGoogleCacheStore({
      preflight: { minTokens: 2_048, countTokens: () => Promise.resolve(100) },
    })
    await expect(caches.create(input)).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect(caches.created).toBe(0)
    const enough = new FakeGoogleCacheStore({
      preflight: { minTokens: 2_048, countTokens: () => Promise.resolve(2_048) },
    })
    await expect(enough.create(input)).resolves.toBeDefined()
  })

  it('coalesce makes concurrent getOrCreate calls for one key share one create', async () => {
    const key = { model: 'gemini-3-pro', stableKey: 'k' }
    const factory = () => Promise.resolve({ ttlSeconds: 600 })
    const shared = new FakeGoogleCacheStore({ coalesce: true })
    const [a, b] = await Promise.all([
      shared.getOrCreate(key, factory),
      shared.getOrCreate(key, factory),
    ])
    expect(b).toBe(a)
    expect(shared.created).toBe(1)

    const plain = new FakeGoogleCacheStore()
    await Promise.all([plain.getOrCreate(key, factory), plain.getOrCreate(key, factory)])
    expect(plain.created).toBe(2)
  })
})

describe('fakeLlmResult does not claim a price it was not given', () => {
  it('defaults to an unpriced, estimated cost and counts the attempt as unpriced', () => {
    const result = fakeLlmResult()
    expect(result.cost).toMatchObject({
      microUsd: null,
      usd: null,
      confidence: 'estimated',
    })
    expect(result.cost?.unpricedReason).toBeTypeOf('string')
    expect(result.callCost).toEqual({ microUsd: 0, attempts: 1, unpricedAttempts: 1 })
  })

  it('a cost the test passes is used as given', () => {
    const result = fakeLlmResult({
      cost: {
        microUsd: 0,
        usd: 0,
        pricingVersion: 'v',
        confidence: 'exact',
        details: { input: 0, cached: 0, output: 0, tools: 0 },
      },
    })
    expect(result.callCost).toEqual({ microUsd: 0, attempts: 1, unpricedAttempts: 0 })
  })

  it('two results carry different callId and attemptId unless the test gives them', () => {
    const a = fakeLlmResult()
    const b = fakeLlmResult()
    expect(a.callId).not.toBe(b.callId)
    expect(a.attemptId).not.toBe(b.attemptId)
    expect(fakeLlmResult({ callId: 'x', attemptId: 'y' })).toMatchObject({
      callId: 'x',
      attemptId: 'y',
    })
  })
})

describe('adopt rebuilds an error from another copy of core with every field', () => {
  it('carries mayHaveBilled and the rest of LlmErrorOptions onto this copy of LlmError', () => {
    // What a classifier from a CommonJS build of a provider package returns: the
    // LlmError shape, but not an instance of this copy's class.
    const foreign = Object.assign(new Error('stream cut'), {
      kind: 'rate_limited',
      retryable: false,
      reason: 'quota_window',
      httpStatus: 429,
      retryAfterMs: 10,
      provider: 'xai',
      callId: 'c1',
      attemptId: 'a1',
      servedServiceTier: 'default',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      mayHaveBilled: true,
      warnings: [{ type: 'other', message: 'w' }],
      issues: [{ path: 'p', message: 'm' }],
    })
    const adopted = adopt(foreign)
    expect(adopted).toBeInstanceOf(LlmError)
    expect(llmErrorOptionsOf(adopted as LlmError)).toEqual(
      llmErrorOptionsOf(foreign as never),
    )
    expect((adopted as LlmError).message).toBe('stream cut')
    expect((adopted as LlmError).mayHaveBilled).toBe(true)
  })

  it('leaves an LlmError of this copy, and a value that is not error-shaped, alone', () => {
    const own = new LlmError('x', { kind: 'server', retryable: false })
    expect(adopt(own)).toBe(own)
    expect(adopt('text')).toBe('text')
    expect(adopt({ kind: 'server' })).toEqual({ kind: 'server' })
  })
})
