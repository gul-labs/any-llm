import { describe, expect, it, vi } from 'vitest'

import {
  createClient,
  createModelRegistry,
  LlmError,
  retryMiddleware,
  spendPreflightMiddleware,
} from './index.js'
import type { AdapterResult, EngineCtx, ResolvedRequest } from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'

const REQ = { provider: 'p', model: 'm', messages: [], config: {} } as ResolvedRequest
const CTX = {} as EngineCtx
const RESULT = { text: 'ok' } as never

function setup(spent: unknown, limit = 1000) {
  const spentSoFar = vi.fn(async () => spent as number)
  const next = vi.fn(async () => RESULT)
  const mw = spendPreflightMiddleware({
    limitMicroUsd: limit,
    key: 'tenant-1',
    spentSoFar,
  })
  return { mw, spentSoFar, next }
}

describe('spendPreflightMiddleware', () => {
  it('passes the call through below the ceiling and reads the host ledger by key', async () => {
    const { mw, spentSoFar, next } = setup(999)
    await expect(mw.intercept(REQ, CTX, next)).resolves.toBe(RESULT)
    expect(spentSoFar).toHaveBeenCalledWith('tenant-1', CTX)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each([1000, 1001])(
    'refuses at or above the ceiling (%d) with rate_limited, not retryable, spend_ceiling',
    async (spent) => {
      const { mw, next } = setup(spent)
      const err = await mw.intercept(REQ, CTX, next).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: false,
        reason: 'spend_ceiling',
        provider: 'p',
      })
      expect((err as LlmError).message).toContain('tenant-1')
      expect(next).not.toHaveBeenCalled()
    },
  )

  it('a zero limit refuses every call', async () => {
    const { mw, next } = setup(0, 0)
    await expect(mw.intercept(REQ, CTX, next)).rejects.toMatchObject({
      reason: 'spend_ceiling',
    })
  })

  it('accepts a key function of the request', async () => {
    const spentSoFar = vi.fn(async () => 0)
    const mw = spendPreflightMiddleware({
      limitMicroUsd: 10,
      key: (req) => `${req.provider}:${req.model}`,
      spentSoFar,
    })
    await mw.intercept(REQ, CTX, async () => RESULT)
    expect(spentSoFar).toHaveBeenCalledWith('p:m', CTX)
  })

  it('sets no role and defaults its id', () => {
    const { mw } = setup(0)
    expect(mw.id).toBe('spend-preflight')
    expect(mw.role).toBeUndefined()
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number])(
    'rejects an invalid ledger reading (%s) as bad_request without dispatching',
    async (bad) => {
      const { mw, next } = setup(bad)
      await expect(mw.intercept(REQ, CTX, next)).rejects.toMatchObject({
        kind: 'bad_request',
      })
      expect(next).not.toHaveBeenCalled()
    },
  )

  it('rejects an invalid limit at construction and an empty key per call', async () => {
    for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        spendPreflightMiddleware({ limitMicroUsd: limit, key: 'k', spentSoFar: () => 0 }),
      ).toThrow(/limitMicroUsd/)
    }
    const mw = spendPreflightMiddleware({
      limitMicroUsd: 10,
      key: () => '',
      spentSoFar: () => 0,
    })
    await expect(mw.intercept(REQ, CTX, async () => RESULT)).rejects.toMatchObject({
      kind: 'bad_request',
    })
  })

  it('lets an error from the ledger read propagate', async () => {
    const boom = new Error('ledger down')
    const mw = spendPreflightMiddleware({
      limitMicroUsd: 10,
      key: 'k',
      spentSoFar: () => {
        throw boom
      },
    })
    await expect(mw.intercept(REQ, CTX, async () => RESULT)).rejects.toBe(boom)
  })
})

describe('spendPreflightMiddleware inside a client', () => {
  const ok: AdapterResult = {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'm',
    warnings: [],
  }

  function build(spent: () => number) {
    const adapter = new FakeAdapter('p', [
      new LlmError('busy', { kind: 'rate_limited', retryable: true }),
      ok,
    ])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: {
        p: makeTestPricingSource(
          { m: { standard: { inputPerM: 1, cachedPerM: 1, outputPerM: 1 } } },
          'v1',
        ),
      },
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
      ]),
      clock: new FakeClock(),
      ids: new FakeIds(),
      sink,
      middleware: [
        retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 }),
        spendPreflightMiddleware({
          limitMicroUsd: 100,
          key: 'k',
          spentSoFar: spent,
        }),
      ],
    })
    return { adapter, sink, client }
  }
  const request = {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }],
  }

  it('below the ceiling the call is dispatched and retried as usual', async () => {
    const { adapter, client } = build(() => 10)
    await expect(
      client.generate(request, { auth: { apiKey: 'k' } }),
    ).resolves.toBeDefined()
    expect(adapter.calls).toHaveLength(2)
  })

  it('refuses at the ceiling with a non-retryable error, no dispatch and a refusal row', async () => {
    const { adapter, sink, client } = build(() => 100)
    await expect(
      client.generate(request, { auth: { apiKey: 'k' } }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'spend_ceiling',
    })
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records.at(-1)).toMatchObject({
      errorKind: 'rate_limited',
      errorReason: 'spend_ceiling',
    })
  })

  it('stops a retry once the ceiling is reached mid-call', async () => {
    let reads = 0
    const { adapter, client } = build(() => (++reads === 1 ? 10 : 100))
    await expect(
      client.generate(request, { auth: { apiKey: 'k' } }),
    ).rejects.toMatchObject({
      reason: 'spend_ceiling',
    })
    expect(adapter.calls).toHaveLength(1)
  })
})
