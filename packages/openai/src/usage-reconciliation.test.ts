/**
 * Raw usage counters that do not reconcile are unpriced, end to end: through
 * `createClient` with the OpenAI pricing source, so core's normalisation (which
 * clamps) runs between the adapter and the price. The usage objects are
 * synthetic; they prove the reconciliation rules, not what OpenAI reports.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient } from '@gullabs/core'
import { FakeClock, FakeIds } from '@gullabs/testing'

import { openaiAdapter } from './adapter.js'
import type { OpenAiResponseShape, OpenAiUsageShape } from './client.js'
import { openaiRegistry } from './models.js'
import { openaiPricingSource } from './pricing.js'

function clientReturning(usage: unknown) {
  const response: OpenAiResponseShape = {
    id: 'resp_1',
    model: 'gpt-6.2-sol',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    usage: usage as OpenAiUsageShape,
    service_tier: 'default',
  }
  return createClient({
    adapters: [
      openaiAdapter({
        client: {
          responses: { create: () => Promise.resolve(structuredClone(response)) },
        },
      }),
    ],
    modelRegistry: openaiRegistry,
    pricingSources: { openai: openaiPricingSource() },
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
}

const generate = (usage: unknown) =>
  clientReturning(usage).generate(
    {
      provider: 'openai',
      model: 'gpt-6.2-sol',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
    },
    { auth: { apiKey: 'sk-doc' } },
  )

const base = (patch: {
  input?: number
  output?: number
  cached?: unknown
  writes?: unknown
  ttl?: unknown
  reasoning?: unknown
  total?: unknown
}) => ({
  input_tokens: patch.input ?? 50,
  input_tokens_details: {
    cached_tokens: 'cached' in patch ? patch.cached : 0,
    cache_write_tokens: 'writes' in patch ? patch.writes : 0,
    ...('ttl' in patch ? { cache_write_tokens_details: patch.ttl } : {}),
  },
  output_tokens: patch.output ?? 10,
  output_tokens_details: { reasoning_tokens: 'reasoning' in patch ? patch.reasoning : 0 },
  ...('total' in patch ? { total_tokens: patch.total } : {}),
})

describe('irreconcilable raw usage is unpriced through the engine', () => {
  it('control: reconciled usage is priced exact', async () => {
    const result = await generate(base({ cached: 10 }))
    expect(result.cost?.microUsd).not.toBeNull()
    expect(result.cost?.confidence).toBe('exact')
  })

  it.each([
    [
      'cached reads above the gross input',
      base({ input: 50, cached: 100 }),
      /exceed input_tokens/,
    ],
    [
      'reads plus writes above the input',
      base({ input: 50, cached: 30, writes: 30 }),
      /exceed input_tokens/,
    ],
    [
      'a negative TTL count',
      base({ writes: 10, ttl: { ttl_30m_tokens: 20, ttl_12h_tokens: -10 } }),
      /ttl_12h_tokens is -10/,
    ],
    [
      'a TTL split that does not sum to the writes',
      base({ writes: 10, ttl: { ttl_30m_tokens: 4, ttl_12h_tokens: 4 } }),
      /TTL split \(4 \+ 4\) differs from cache_write_tokens \(10\)/,
    ],
    [
      'a TTL split without a write count',
      {
        ...base({}),
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens_details: { ttl_30m_tokens: 5, ttl_12h_tokens: 0 },
        },
      },
      /differs from cache_write_tokens \(absent\)/,
    ],
    [
      'reasoning above the output',
      base({ output: 10, reasoning: 11 }),
      /reasoning_tokens \(11\) exceed output_tokens \(10\)/,
    ],
    ['a fractional cached count', base({ cached: 1.5 }), /cached_tokens is 1.5/],
    ['a negative write count', base({ writes: -1 }), /cache_write_tokens is -1/],
    ['a string reasoning count', base({ reasoning: '3' }), /reasoning_tokens is "3"/],
    ['a negative total', base({ total: -5 }), /total_tokens is -5/],
    [
      'a total below input plus output',
      { ...base({ input: 50, output: 10 }), total_tokens: 5 },
      /total_tokens \(5\) is below input_tokens plus output_tokens \(60\)/,
    ],
  ])('%s', async (_label, usage, warning) => {
    const result = await generate(usage)
    expect(result.cost?.microUsd).toBeNull()
    expect(result.cost?.unpricedReason).toContain('do not reconcile')
    expect(result.usage.details['usage_irreconcilable']).toBe(1)
    expect(result.warnings.some((w) => warning.test(w.message))).toBe(true)
  })

  it('usage missing its cache lanes stays unpriced as incomplete', async () => {
    const result = await generate({ input_tokens: 50, output_tokens: 10 })
    expect(result.cost?.microUsd).toBeNull()
    expect(result.usage.details['usage_incomplete']).toBe(1)
  })

  it('a total above input plus output is priced, estimated (tokens the lanes do not carry)', async () => {
    const result = await generate({
      ...base({ input: 50, output: 10 }),
      total_tokens: 70,
    })
    expect(result.cost?.microUsd).not.toBeNull()
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.usage.details['usage_irreconcilable']).toBeUndefined()
  })
})
