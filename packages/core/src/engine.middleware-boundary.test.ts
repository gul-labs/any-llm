/**
 * Middleware boundary tests for @gullabs/core (ADR-037, ADR-033).
 *
 * A middleware cannot change the call's provider or model: the engine guards
 * the `next` it hands to every middleware, and `runAttempt` dispatches with the
 * identity recorded at call start. Also covers declared aliases on the engine
 * path and the host-side fallback pattern that replaces rerouting middleware.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, LlmError, retryMiddleware } from './index.js'
import type {
  AdapterCtx,
  AdapterResult,
  Middleware,
  ProviderAdapter,
  ResolvedRequest,
  Usage,
} from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makeTestPricingSource } from './test-pricing-source.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const USAGE: Usage = { inputTokens: 1_000_000, outputTokens: 0, details: {}, raw: null }

function result(model: string): AdapterResult {
  return { text: 'ok', usage: USAGE, model, warnings: [] }
}

// Per-model input rates differ so a wrong-descriptor price is detectable.
// inputPerM is micro-USD per million tokens; 1M input tokens cost exactly it.
const GOOGLE_PRICING = makeTestPricingSource(
  {
    'g-pro': { standard: { inputPerM: 1_000_000, cachedPerM: 0, outputPerM: 0 } },
    'g-flash': { standard: { inputPerM: 300_000, cachedPerM: 0, outputPerM: 0 } },
  },
  'g-pricing-1',
)
const XAI_PRICING = makeTestPricingSource(
  { 'x-model': { standard: { inputPerM: 5_000_000, cachedPerM: 0, outputPerM: 0 } } },
  'x-pricing-1',
)

const G_PRO = makePermissiveTestDescriptor({
  provider: 'google',
  model: 'g-pro',
  aliases: ['g-pro-001'],
})
const G_FLASH = makePermissiveTestDescriptor({ provider: 'google', model: 'g-flash' })
const X_MODEL = makePermissiveTestDescriptor({ provider: 'xai', model: 'x-model' })
const REGISTRY = createModelRegistry([G_PRO, G_FLASH, X_MODEL])
const GOOGLE_ONLY = createModelRegistry([G_PRO, G_FLASH])

const AUTH = { apiKey: 'test-key' }
const MESSAGES = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
]

function setup(middleware: Middleware[], opts?: { googleModelResult?: string }) {
  const google = new FakeAdapter('google', result(opts?.googleModelResult ?? 'g-pro'))
  const xai = new FakeAdapter('xai', result('x-model'))
  const sink = new RecordingSink()
  const client = createClient({
    adapters: [google, xai],
    pricingSources: { google: GOOGLE_PRICING, xai: XAI_PRICING },
    modelRegistry: REGISTRY,
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
    middleware,
  })
  return { client, google, xai, sink }
}

/** Quota-shaped middleware: counts how many units it consumed. */
function countingQuota(counter: { units: number }): Middleware {
  return {
    id: 'counting-quota',
    role: 'quota',
    async intercept(req, ctx, next) {
      counter.units++
      return next(req, ctx)
    },
  }
}

describe('middleware cannot change the provider or model (ADR-037)', () => {
  it('rejects a Google -> xAI switch at the offender next: no provider call, no inner quota consumed, refusal row written', async () => {
    const quota = { units: 0 }
    const rerouter: Middleware = {
      id: 'rerouter',
      async intercept(req, ctx, next) {
        return next({ ...req, provider: 'xai', model: 'x-model' }, ctx)
      },
    }
    const { client, google, xai, sink } = setup([rerouter, countingQuota(quota)])

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'g-pro',
          messages: MESSAGES,
          config: { serviceTier: 'flex' },
          externalId: 'op-1',
        },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((err as LlmError).message).toMatch(/may not change the provider or model/)
    expect((err as LlmError).issues?.map((i) => i.path)).toEqual(['provider', 'model'])
    expect(google.calls).toHaveLength(0)
    expect(xai.calls).toHaveLength(0)
    expect(quota.units).toBe(0)

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      attemptNumber: 0,
      status: 'api_error',
      errorKind: 'bad_request',
      provider: 'google',
      model: 'g-pro',
      externalId: 'op-1',
    })
    expect(sink.records[0]!.costMicroUsd).toBeUndefined()
  })

  it('rejects a same-provider model switch the same way', async () => {
    const quota = { units: 0 }
    const rerouter: Middleware = {
      id: 'rerouter',
      async intercept(req, ctx, next) {
        return next({ ...req, model: 'g-flash' }, ctx)
      },
    }
    const { client, google, sink } = setup([rerouter, countingQuota(quota)])

    await expect(
      client.generate(
        { provider: 'google', model: 'g-pro', messages: MESSAGES },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })

    expect(google.calls).toHaveLength(0)
    expect(quota.units).toBe(0)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.attemptNumber).toBe(0)
  })

  it('rejects an in-place provider or model assignment made before next', async () => {
    const mutator: Middleware = {
      id: 'mutator',
      async intercept(req, ctx, next) {
        ;(req as { model: string }).model = 'g-flash'
        return next(req, ctx)
      },
    }
    const { client, google } = setup([mutator])

    await expect(
      client.generate(
        { provider: 'google', model: 'g-pro', messages: MESSAGES },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(google.calls).toHaveLength(0)
  })

  it('a quota unit taken by a middleware outside the offender is not refunded', async () => {
    const outer = { units: 0 }
    const rerouter: Middleware = {
      id: 'rerouter',
      async intercept(req, ctx, next) {
        return next({ ...req, model: 'g-flash' }, ctx)
      },
    }
    const { client } = setup([countingQuota(outer), rerouter])

    await expect(
      client.generate(
        { provider: 'google', model: 'g-pro', messages: MESSAGES },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(outer.units).toBe(1)
  })

  it('a swapped modelDescriptor, and provider/model assigned after next, change nothing about dispatch, price or auth', async () => {
    const swapped: Middleware = {
      id: 'descriptor-swapper',
      async intercept(req, ctx, next) {
        // In-place descriptor swap before next: not a provider/model change, so
        // it passes the boundary, but the engine ignores it.
        ;(req as { modelDescriptor?: unknown }).modelDescriptor = G_FLASH
        const out = await next(req, ctx)
        // Assignments after next: the dispatch already happened.
        ;(req as { provider: string }).provider = 'xai'
        ;(req as { model: string }).model = 'x-model'
        ;(req as { modelDescriptor?: unknown }).modelDescriptor = X_MODEL
        return out
      },
    }

    const seen: Array<{ req: ResolvedRequest; ctx: AdapterCtx }> = []
    const inner = new FakeAdapter('google', result('g-pro'))
    const capturing: ProviderAdapter = {
      id: 'google',
      async run(req, ctx) {
        seen.push({ req, ctx })
        return inner.run(req, ctx)
      },
    }
    const xai = new FakeAdapter('xai', result('x-model'))
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [capturing, xai],
      pricingSources: { google: GOOGLE_PRICING, xai: XAI_PRICING },
      modelRegistry: REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [swapped],
    })

    const out = await client.generate(
      { provider: 'google', model: 'g-pro', messages: MESSAGES },
      { auth: { apiKey: 'call-key', keyId: 'k1' } },
    )

    expect(xai.calls).toHaveLength(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.req.provider).toBe('google')
    expect(seen[0]!.req.model).toBe('g-pro')
    expect(seen[0]!.req.modelDescriptor).toBe(G_PRO)
    expect(seen[0]!.ctx.auth).toEqual({ apiKey: 'call-key', keyId: 'k1' })
    // Priced at g-pro's 1_000_000 per M, not g-flash's or x-model's.
    expect(out.cost?.microUsd).toBe(1_000_000)
    expect(sink.records[0]).toMatchObject({
      provider: 'google',
      model: 'g-pro',
      costMicroUsd: 1_000_000,
      authKeyId: 'k1',
    })
  })

  it('a call on a declared alias passes the boundary, is dispatched with the alias string, and is priced under the canonical descriptor', async () => {
    const passthrough: Middleware = {
      id: 'passthrough',
      async intercept(req, ctx, next) {
        return next(req, ctx)
      },
    }
    const { client, google, sink } = setup([
      retryMiddleware({ maxAttempts: 2, baseDelayMs: 0 }),
      passthrough,
    ])

    const out = await client.generate(
      { provider: 'google', model: 'g-pro-001', messages: MESSAGES },
      { auth: AUTH },
    )

    expect(google.calls[0]!.model).toBe('g-pro-001')
    expect(google.calls[0]!.modelDescriptor).toBe(G_PRO)
    expect(out.cost?.microUsd).toBe(1_000_000)
    expect(sink.records[0]!.model).toBe('g-pro-001')
  })

  it('an undeclared sibling of a registered id is rejected by the registry with the closest ids', async () => {
    const { client, google, sink } = setup([])

    const err = await client
      .generate(
        { provider: 'google', model: 'g-pro-image', messages: MESSAGES },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((err as LlmError).message).toContain('g-pro-image')
    expect((err as LlmError).message).toContain('"g-pro"')
    expect(google.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(0)
  })

  it('a middleware that passes a new request object with changed config or metadata still works', async () => {
    const reconfigure: Middleware = {
      id: 'reconfigure',
      async intercept(req, ctx, next) {
        return next({ ...req, config: { ...req.config, temperature: 0.2 } }, ctx)
      },
    }
    const { client, google } = setup([reconfigure])

    await client.generate(
      { provider: 'google', model: 'g-pro', messages: MESSAGES },
      { auth: AUTH },
    )

    expect(google.calls).toHaveLength(1)
    expect(google.calls[0]!.config).toMatchObject({ temperature: 0.2 })
  })

  it('host-side fallback: catch, call again on the other target; two correctly priced rows share an externalId', async () => {
    const google = new FakeAdapter(
      'google',
      new LlmError('down', { kind: 'server', retryable: false }),
    )
    const xai = new FakeAdapter('xai', result('x-model'))
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [google, xai],
      pricingSources: { google: GOOGLE_PRICING, xai: XAI_PRICING },
      modelRegistry: REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    async function generateWithFallback() {
      const targets = [
        { provider: 'google', model: 'g-pro' },
        { provider: 'xai', model: 'x-model' },
      ]
      let last: unknown
      for (const target of targets) {
        try {
          return await client.generate(
            { ...target, messages: MESSAGES, externalId: 'op-fallback' },
            { auth: AUTH },
          )
        } catch (e) {
          last = e
        }
      }
      throw last
    }

    const out = await generateWithFallback()

    expect(out.cost?.microUsd).toBe(5_000_000)
    expect(sink.records).toHaveLength(2)
    expect(sink.records.map((r) => [r.provider, r.model, r.status])).toEqual([
      ['google', 'g-pro', 'api_error'],
      ['xai', 'x-model', 'ok'],
    ])
    expect(sink.records[1]!.costMicroUsd).toBe(5_000_000)
    expect(sink.records.map((r) => r.externalId)).toEqual(['op-fallback', 'op-fallback'])
    expect(sink.records[0]!.callId).not.toBe(sink.records[1]!.callId)
  })
})

describe('quota placement relative to retry (role)', () => {
  const retry = retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })

  function build(middleware: Middleware[]) {
    return () =>
      createClient({
        adapters: [new FakeAdapter('google', result('g-pro'))],
        modelRegistry: GOOGLE_ONLY,
        middleware,
      })
  }

  it('retryMiddleware carries role "retry"', () => {
    expect(retry.role).toBe('retry')
  })

  it('accepts [retry, quota] and quota alone', () => {
    const quota = countingQuota({ units: 0 })
    expect(build([retry, quota])).not.toThrow()
    expect(build([quota])).not.toThrow()
    expect(build([retry])).not.toThrow()
  })

  it('rejects [quota, retry] with bad_request at construction', () => {
    const quota = countingQuota({ units: 0 })
    expect(build([quota, retry])).toThrow(LlmError)
    expect(build([quota, retry])).toThrow(/place quota inside retry/)
  })

  it('identifies by role, not id: custom ids do not defeat or trigger the check', () => {
    const quota: Middleware = { ...countingQuota({ units: 0 }), id: 'my-retry' }
    const customRetry: Middleware = { ...retry, id: 'my-quota' }
    expect(build([quota, customRetry])).toThrow(/place quota inside retry/)
    // A host middleware merely NAMED like a built-in has no role and is ignored.
    const namedQuota: Middleware = { id: 'provider-quota', intercept: quota.intercept }
    const namedRetry: Middleware = { id: 'retry', intercept: retry.intercept }
    expect(build([namedQuota, namedRetry])).not.toThrow()
  })

  it('with [retry, quota] three attempts consume three units', async () => {
    const counter = { units: 0 }
    const flaky = new FakeAdapter('google', [
      new LlmError('t', { kind: 'server', retryable: true }),
      new LlmError('t', { kind: 'server', retryable: true }),
      result('g-pro'),
    ])
    const client = createClient({
      adapters: [flaky],
      modelRegistry: GOOGLE_ONLY,
      middleware: [retry, countingQuota(counter)],
    })

    await client.generate(
      { provider: 'google', model: 'g-pro', messages: MESSAGES },
      { auth: AUTH },
    )

    expect(flaky.calls).toHaveLength(3)
    expect(counter.units).toBe(3)
  })
})
