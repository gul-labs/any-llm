/**
 * Ledger v2 and cost observability in the engine (R7.1, R7.3, R7.4):
 *
 * - the record carries `costConfidence`, `costDetails`, `costUnpricedReason`
 *   and `recordSchemaVersion: 2`;
 * - `Telemetry.onAttempt` fires once per provider attempt;
 * - `LlmResult.callCost` sums every attempt, `CallErrorEvent` carries usage,
 *   cost and the call total;
 * - a provider-reported total that drifts from the priced total warns.
 */

import { describe, expect, it } from 'vitest'
import { LlmError, createClient, createModelRegistry } from './index.js'
import type {
  AdapterResult,
  AttemptEvent,
  CallErrorEvent,
  Cost,
  PricingSource,
  Usage,
} from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'
import { retryMiddleware } from './retry.js'
import { providerCostDriftWarning } from './cost.js'

// 1 µUSD per input token, 2 per output token.
const RATES = {
  inputPerM: 1_000_000,
  cachedPerM: 500_000,
  outputPerM: 2_000_000,
}
const PRICING = makeTestPricingSource({ m1: { standard: RATES } }, 'test-pricing-1')
const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'm1', provider: 'google' }),
  makePermissiveTestDescriptor({ model: 'unpriced', provider: 'google' }),
])
const AUTH = { apiKey: 'test-key' }

function usage(overrides: Partial<Usage> = {}): Usage {
  return { inputTokens: 100, outputTokens: 50, details: {}, raw: {}, ...overrides }
}

function ok(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    model: 'm1',
    usage: usage(),
    warnings: [],
    finishReason: 'stop',
    ...overrides,
  }
}

function request(model = 'm1') {
  return {
    provider: 'google',
    model,
    messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] }],
  }
}

function makeClient(
  entries: ConstructorParameters<typeof FakeAdapter>[1],
  extra: {
    pricing?: PricingSource
    retry?: boolean
  } = {},
) {
  const sink = new RecordingSink()
  const attempts: AttemptEvent[] = []
  const errors: CallErrorEvent[] = []
  const client = createClient({
    adapters: [new FakeAdapter('google', entries)],
    pricingSources: { google: extra.pricing ?? PRICING },
    modelRegistry: REGISTRY,
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
    telemetry: {
      onAttempt: (e) => void attempts.push(e),
      onError: (e) => void errors.push(e),
    },
    ...(extra.retry === true
      ? { middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })] }
      : {}),
  })
  return { client, sink, attempts, errors }
}

describe('R7.1 the record persists cost confidence, lanes and the unpriced reason', () => {
  it('an exact priced call', async () => {
    const { client, sink } = makeClient(ok())
    await client.generate(request(), { auth: AUTH })
    const row = sink.last()
    expect(row?.recordSchemaVersion).toBe(2)
    expect(row?.costMicroUsd).toBe(100 + 100)
    expect(row?.costConfidence).toBe('exact')
    expect(row?.costDetails).toEqual({ input: 100, cached: 0, output: 100, tools: 0 })
    expect(row?.costUnpricedReason).toBeUndefined()
  })

  it('a call priced from fields that miss billed tokens is persisted as estimated', async () => {
    const { client, sink } = makeClient(
      ok({ usage: usage({ totalTokens: 400 }) }), // 100 + 50 < 400
    )
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.cost?.confidence).toBe('estimated')
    expect(sink.last()?.costConfidence).toBe('estimated')
    expect(sink.last()?.costMicroUsd).toBe(200)
  })

  it('an unpriced model keeps the reason and a null amount', async () => {
    const { client, sink } = makeClient(ok({ model: 'unpriced' }))
    await client.generate(request('unpriced'), { auth: AUTH })
    const row = sink.last()
    expect(row?.costMicroUsd).toBeNull()
    expect(row?.costConfidence).toBe('estimated')
    expect(row?.costUnpricedReason).toMatch(/Unknown model "unpriced"/)
    expect('costDetails' in (row ?? {})).toBe(false)
  })

  it('a billed failure row carries its cost fields; a refusal row carries none', async () => {
    const { client, sink } = makeClient(
      new LlmError('empty candidate', {
        kind: 'server',
        retryable: false,
        usage: usage(),
      }),
    )
    await expect(client.generate(request(), { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    expect(sink.last()?.costConfidence).toBe('exact')
    expect(sink.last()?.costDetails).toEqual({
      input: 100,
      cached: 0,
      output: 100,
      tools: 0,
    })

    const refused = makeClient(ok(), {})
    await expect(
      refused.client.generate({ ...request(), model: 'nope' }, { auth: AUTH }),
    ).rejects.toBeInstanceOf(LlmError)
    expect(refused.sink.last()?.costConfidence).toBeUndefined()
    expect(refused.sink.last()?.costMicroUsd).toBeUndefined()
  })
})

describe('R7.3 per-attempt telemetry and the cost of the whole call', () => {
  const billedFailure = () =>
    new LlmError('empty 200', {
      kind: 'server',
      retryable: true,
      usage: usage({ inputTokens: 10, outputTokens: 5 }),
    })

  it('onAttempt fires once per attempt, failures and the success, with usage and cost', async () => {
    const { client, attempts } = makeClient([billedFailure(), billedFailure(), ok()], {
      retry: true,
    })
    const result = await client.generate(request(), { auth: AUTH })
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3])
    expect(new Set(attempts.map((a) => a.callId)).size).toBe(1)
    expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(3)
    expect(attempts.map((a) => a.errorKind)).toEqual(['server', 'server', undefined])
    expect(attempts[0]?.retryable).toBe(true)
    expect(attempts[0]?.usage.inputTokens).toBe(10)
    expect(attempts[0]?.cost?.microUsd).toBe(10 + 10)
    expect(attempts[2]?.cost?.microUsd).toBe(200)
    expect(attempts[2]?.attemptId).toBe(result.attemptId)
  })

  it('a middleware refusal that never reached an attempt emits no onAttempt', async () => {
    const attempts: AttemptEvent[] = []
    const client = createClient({
      adapters: [new FakeAdapter('google', ok())],
      pricingSources: { google: PRICING },
      modelRegistry: REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry: { onAttempt: (e) => void attempts.push(e) },
      middleware: [
        {
          id: 'refuse',
          async intercept() {
            throw new LlmError('no', { kind: 'rate_limited', retryable: false })
          },
        },
      ],
    })
    await expect(client.generate(request(), { auth: AUTH })).rejects.toMatchObject({
      kind: 'rate_limited',
    })
    expect(attempts).toEqual([])
  })

  it('a throwing onAttempt never fails the call', async () => {
    const client = createClient({
      adapters: [new FakeAdapter('google', ok())],
      pricingSources: { google: PRICING },
      modelRegistry: REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry: {
        onAttempt() {
          throw new Error('hook bug')
        },
      },
    })
    await expect(client.generate(request(), { auth: AUTH })).resolves.toMatchObject({
      text: 'ok',
    })
  })

  it('callCost sums the billed failures and the success; cost stays the last attempt', async () => {
    const { client } = makeClient([billedFailure(), billedFailure(), ok()], {
      retry: true,
    })
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.cost?.microUsd).toBe(200)
    expect(result.callCost).toEqual({ microUsd: 20 + 20 + 200, attempts: 3 })
  })

  it('a first-attempt success has a callCost of one attempt', async () => {
    const { client } = makeClient(ok())
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.callCost).toEqual({ microUsd: 200, attempts: 1 })
  })

  it('an attempt that failed without usage adds nothing but still counts as an attempt', async () => {
    const { client } = makeClient(
      [new LlmError('reset', { kind: 'server', retryable: true }), ok()],
      { retry: true },
    )
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.callCost).toEqual({ microUsd: 200, attempts: 2 })
  })

  it('callCost is absent when the call is unpriced (a sum with a hole is not reported)', async () => {
    const { client } = makeClient(ok({ model: 'unpriced' }))
    const result = await client.generate(request('unpriced'), { auth: AUTH })
    expect(result.callCost).toBeUndefined()
  })

  it('CallErrorEvent carries the failing attempt usage and cost, and the call total', async () => {
    const { client, errors } = makeClient(
      [billedFailure(), billedFailure(), billedFailure()],
      { retry: true },
    )
    await expect(client.generate(request(), { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]?.usage?.inputTokens).toBe(10)
    expect(errors[0]?.cost?.microUsd).toBe(20)
    expect(errors[0]?.callCost).toEqual({ microUsd: 60, attempts: 3 })
    expect(errors[0]?.reason).toBeUndefined()
  })

  it('CallErrorEvent has no usage or cost when the failure carried none; reason still flows', async () => {
    const { client, errors } = makeClient(
      new LlmError('transport', {
        kind: 'timeout',
        retryable: false,
        reason: 'transport_timeout',
      }),
    )
    await expect(client.generate(request(), { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    expect(errors[0]?.usage).toBeUndefined()
    expect(errors[0]?.cost).toBeUndefined()
    expect(errors[0]?.callCost).toBeUndefined()
    expect(errors[0]?.reason).toBe('transport_timeout')
  })
})

describe('R7.4 provider-reported total versus the priced total', () => {
  function reportingSource(providerMicroUsd: number | undefined): PricingSource {
    return {
      version: 'reporting-1',
      price(_model: string, u: Usage): Cost {
        const input = u.inputTokens
        const output = u.outputTokens * 2
        return {
          microUsd: input + output,
          usd: (input + output) / 1_000_000,
          pricingVersion: 'reporting-1',
          confidence: 'exact',
          details: { input, cached: 0, output, tools: 0 },
          ...(providerMicroUsd !== undefined
            ? { providerReported: { microUsd: providerMicroUsd } }
            : {}),
        }
      },
      hasModel: () => true,
      listModels: () => ['m1'],
    }
  }

  it('is silent when the totals agree within one µUSD per priced lane', async () => {
    // Priced: 100 + 100 = 200 over two lanes; tolerance 2.
    for (const reported of [200, 201, 202, 198]) {
      const { client } = makeClient(ok(), { pricing: reportingSource(reported) })
      const result = await client.generate(request(), { auth: AUTH })
      expect(result.warnings, `reported ${reported}`).toEqual([])
      expect(result.cost?.providerReported).toEqual({ microUsd: reported })
    }
  })

  it('warns, and persists the warning, when they differ by more than that', async () => {
    const { client, sink } = makeClient(ok(), { pricing: reportingSource(203) })
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.message).toContain('cost drift')
    expect(result.warnings[0]?.message).toContain('reported 203')
    expect(result.warnings[0]?.message).toContain('computed 200')
    expect(sink.last()?.warnings).toEqual(result.warnings)
    // The snapshot price is still the cost.
    expect(result.cost?.microUsd).toBe(200)
  })

  it('compares nothing when the provider reported no total', async () => {
    const { client } = makeClient(ok(), { pricing: reportingSource(undefined) })
    expect((await client.generate(request(), { auth: AUTH })).warnings).toEqual([])
  })

  it('providerCostDriftWarning: tolerance is the number of non-zero priced lanes (min 1)', () => {
    const cost = (
      microUsd: number,
      reported: number,
      details: Cost['details'],
    ): Cost => ({
      microUsd,
      usd: microUsd / 1e6,
      pricingVersion: 'v',
      confidence: 'exact',
      details,
      providerReported: { microUsd: reported },
    })
    const one = { input: 0, cached: 0, output: 500, tools: 0 }
    const four = { input: 100, cached: 100, output: 100, tools: 100 }
    expect(providerCostDriftWarning(cost(500, 501, one))).toBeUndefined()
    expect(providerCostDriftWarning(cost(500, 502, one))).toBeDefined()
    expect(providerCostDriftWarning(cost(400, 404, four))).toBeUndefined()
    expect(providerCostDriftWarning(cost(400, 405, four))).toBeDefined()
    expect(providerCostDriftWarning(cost(400, 396, four))).toBeUndefined()
    expect(providerCostDriftWarning(cost(400, 395, four))).toBeDefined()
  })

  it('an unpriced cost is never compared, even with a provider total', () => {
    expect(
      providerCostDriftWarning({
        microUsd: null,
        usd: null,
        pricingVersion: 'v',
        confidence: 'estimated',
        details: { input: 0, cached: 0, output: 0, tools: 0 },
        providerReported: { microUsd: 5_000 },
      }),
    ).toBeUndefined()
  })
})
