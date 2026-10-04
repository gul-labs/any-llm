/**
 * Engine diagnostics on results and errors.
 *
 * - A `finishReason: 'length'` result with no answer and reasoning tokens
 *   carries a warning, on any provider.
 * - The typed `LlmError.reason` reaches `CallErrorEvent.reason` and the
 *   record's `errorReason`, including the attemptNumber:0 refusal row.
 */

import { describe, expect, it } from 'vitest'
import { LlmError, createClient, createModelRegistry } from './index.js'
import type { AdapterResult, CallErrorEvent, Usage } from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'

const RATES = {
  inputPerM: 1_000_000,
  cachedPerM: 100_000,
  outputPerM: 2_000_000,
  gt200k: { inputPerM: 1_000_000, cachedPerM: 100_000, outputPerM: 2_000_000 },
}
const PRICING = makeTestPricingSource({ m1: { standard: RATES } }, 'test-pricing-1')
const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'm1', provider: 'google' }),
])
const AUTH = { apiKey: 'test-key' }

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 10,
    outputTokens: 500,
    thinkingTokens: 500,
    details: {},
    raw: {},
    ...overrides,
  }
}

function adapterResult(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    message: { role: 'assistant', parts: [] },
    model: 'm1',
    usage: usage(),
    warnings: [],
    finishReason: 'length',
    ...overrides,
  }
}

function makeClient(entry: ConstructorParameters<typeof FakeAdapter>[1], extra = {}) {
  const sink = new RecordingSink()
  const errors: CallErrorEvent[] = []
  const client = createClient({
    adapters: [new FakeAdapter('google', entry)],
    pricingSources: { google: PRICING },
    modelRegistry: REGISTRY,
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
    telemetry: { onError: (e) => void errors.push(e) },
    ...extra,
  })
  return { client, sink, errors }
}

const REQUEST = {
  provider: 'google',
  model: 'm1',
  messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] }],
  config: { maxOutputTokens: 500 },
}

describe('adapter warnings on a billed failure reach the attempt row', () => {
  it('LlmError.warnings are written to the record of the failed attempt', async () => {
    const { client, sink } = makeClient(
      new LlmError('no usable candidate', {
        kind: 'server',
        retryable: false,
        usage: usage({ thinkingTokens: 0 }),
        warnings: [{ type: 'other', message: 'grounding fees are not included' }],
      }),
    )
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toMatchObject({
      kind: 'server',
    })
    expect(sink.last()?.warnings).toEqual([
      { type: 'other', message: 'grounding fees are not included' },
    ])
  })

  it('an error without warnings leaves the row without them', async () => {
    const { client, sink } = makeClient(
      new LlmError('x', { kind: 'server', retryable: false }),
    )
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toBeDefined()
    expect(sink.last()?.warnings).toBeUndefined()
  })
})

describe('reasoning used up the output cap', () => {
  it('warns when length ended the call with no answer and reasoning tokens', async () => {
    const { client, sink } = makeClient(adapterResult())
    const result = await client.generate(REQUEST, { auth: AUTH })

    const hint = result.warnings.find((w) => w.message.includes('used up by reasoning'))
    expect(hint?.message).toContain('maxOutputTokens (500)')
    expect(hint?.message).toContain('(500 tokens)')
    expect(hint?.message).toContain('no answer was produced')
    expect(sink.last()?.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: hint?.message })]),
    )
  })

  it('treats a whitespace-only text as no answer', async () => {
    const { client } = makeClient(adapterResult({ text: '\n  \n' }))
    const result = await client.generate(REQUEST, { auth: AUTH })
    expect(result.warnings.some((w) => w.message.includes('used up by reasoning'))).toBe(
      true,
    )
  })

  it('names the provider default when the call set no cap', async () => {
    const { client } = makeClient(adapterResult())
    const result = await client.generate({ ...REQUEST, config: {} }, { auth: AUTH })
    expect(
      result.warnings.find((w) => w.message.includes('used up by reasoning'))?.message,
    ).toContain('maxOutputTokens (the provider default)')
  })

  it.each([
    ['answer text present', { text: 'partial answer' }],
    [
      'a tool call present',
      {
        toolCalls: [{ toolCallId: 'c1', toolName: 'f', args: {} }],
      },
    ],
    ['structured output present', { rawStructured: { a: 1 } }],
    ['finish reason is stop', { finishReason: 'stop' as const }],
    ['no reasoning tokens', { usage: usage({ thinkingTokens: 0 }) }],
    [
      'reasoning tokens absent',
      { usage: { inputTokens: 10, outputTokens: 500, details: {}, raw: {} } },
    ],
  ])('does not warn when %s', async (_name, overrides) => {
    const { client } = makeClient(adapterResult(overrides as Partial<AdapterResult>))
    const result = await client.generate(REQUEST, { auth: AUTH })
    expect(result.warnings.some((w) => w.message.includes('used up by reasoning'))).toBe(
      false,
    )
  })

  it('applies to any provider id, not just Gemini', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('other', adapterResult())],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm1', provider: 'other' }),
      ]),
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    const result = await client.generate(
      { ...REQUEST, provider: 'other' },
      { auth: AUTH },
    )
    expect(result.warnings.some((w) => w.message.includes('used up by reasoning'))).toBe(
      true,
    )
  })
})

describe('typed error reasons', () => {
  const reasoned = new LlmError('headers took too long', {
    kind: 'timeout',
    retryable: false,
    reason: 'transport_timeout',
  })

  it('reaches CallErrorEvent.reason and the record for a failed attempt', async () => {
    const { client, sink, errors } = makeClient(reasoned)
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toMatchObject({
      reason: 'transport_timeout',
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toBe('transport_timeout')
    expect(sink.last()).toMatchObject({
      attemptNumber: 1,
      errorKind: 'timeout',
      errorReason: 'transport_timeout',
    })
  })

  it('reaches the attemptNumber:0 refusal row when a middleware refuses', async () => {
    const { client, sink, errors } = makeClient(adapterResult({ text: 'unused' }), {
      middleware: [
        {
          id: 'quota-like',
          intercept: async () => {
            throw new LlmError('wait too long', {
              kind: 'rate_limited',
              retryable: false,
              reason: 'quota_window',
            })
          },
        },
      ],
    })
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toMatchObject({
      reason: 'quota_window',
    })

    expect(errors[0]?.reason).toBe('quota_window')
    expect(sink.last()).toMatchObject({
      attemptNumber: 0,
      errorKind: 'rate_limited',
      errorReason: 'quota_window',
    })
  })

  it('omits reason and errorReason when the error has none', async () => {
    const { client, sink, errors } = makeClient(
      new LlmError('boom', { kind: 'server', retryable: true }),
    )
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    expect('reason' in (errors[0] ?? {})).toBe(false)
    expect('errorReason' in (sink.last() ?? {})).toBe(false)
  })
})

describe('tokens the usage fields do not carry', () => {
  const GREATER = 'greater than inputTokens + outputTokens'

  it('totalTokens above input + output: a warning once on the result and the row, cost estimated', async () => {
    const { client, sink } = makeClient(
      adapterResult({
        text: 'answer',
        finishReason: 'stop',
        usage: usage({
          inputTokens: 44,
          outputTokens: 102,
          thinkingTokens: 0,
          totalTokens: 223,
        }),
      }),
    )
    const result = await client.generate(REQUEST, { auth: AUTH })

    expect(result.cost?.confidence).toBe('estimated')
    expect(result.cost?.microUsd).toEqual(expect.any(Number))
    expect(result.warnings.filter((w) => w.message.includes(GREATER))).toHaveLength(1)
    expect(JSON.stringify(sink.last()?.warnings).split(GREATER)).toHaveLength(2)
  })

  it('a consistent total stays exact with no warning', async () => {
    const { client } = makeClient(
      adapterResult({
        text: 'answer',
        finishReason: 'stop',
        usage: usage({
          inputTokens: 44,
          outputTokens: 102,
          thinkingTokens: 0,
          totalTokens: 146,
        }),
      }),
    )
    const result = await client.generate(REQUEST, { auth: AUTH })
    expect(result.cost?.confidence).toBe('exact')
    expect(result.warnings).toEqual([])
  })

  it('a failed billed attempt carries the warning on its row', async () => {
    const { client, sink } = makeClient(
      new LlmError('no usable candidate', {
        kind: 'server',
        retryable: false,
        usage: usage({
          inputTokens: 44,
          outputTokens: 102,
          thinkingTokens: 0,
          totalTokens: 223,
        }),
      }),
    )
    await expect(client.generate(REQUEST, { auth: AUTH })).rejects.toBeDefined()
    expect(JSON.stringify(sink.last()?.warnings)).toContain(GREATER)
  })
})
