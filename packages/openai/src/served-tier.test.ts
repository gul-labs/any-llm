/**
 * The served tier through the engine: the cost follows the tier the response
 * echoes, and a response that echoes none is unpriced rather than priced at the
 * requested tier (core falls back to the requested tier when the adapter
 * reports none, so the adapter marks the absence and the pricing source refuses
 * it). Real `openai` SDK, stubbed `fetch`, documentation-derived frames
 * (`test-sse.ts`); the usage numbers are synthetic.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import { FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'

import { openaiAdapterWithSeams } from './adapter.js'
import { openaiRegistry } from './models.js'
import { openaiPricingSource } from './pricing.js'
import {
  messageItem,
  responseObject,
  sseResponse,
  streamEvents,
  stubFetch,
  usage,
} from './test-sse.js'

function clientFor(response: Record<string, unknown>, terminal?: 'response.failed') {
  const stub = stubFetch(() =>
    sseResponse(streamEvents(response, terminal !== undefined ? { terminal } : {})),
  )
  const sink = new RecordingSink()
  const client = createClient({
    adapters: [openaiAdapterWithSeams(undefined, { fetch: stub.fetch })],
    modelRegistry: openaiRegistry,
    pricingSources: { openai: openaiPricingSource() },
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
  return { client, sink }
}

const call = {
  provider: 'openai',
  model: 'gpt-6.2-sol',
  messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'x' }] }],
  config: { serviceTier: 'fast' },
}
const auth = { auth: { apiKey: 'sk-doc' } }

describe('served tier', () => {
  it('an explicit fast request whose response echoes no tier is unpriced on success', async () => {
    const { client, sink } = clientFor(
      responseObject([messageItem('msg_1', 'ok')], {
        serviceTier: null,
        usage: usage(1_000, 100),
      }),
    )
    const result = await client.generate(call, auth)
    expect(result.cost?.microUsd).toBeNull()
    expect(result.cost?.unpricedReason).toContain('did not echo service_tier')
    expect(result.usage.details['service_tier_missing']).toBe(1)
    expect(
      result.warnings.some((w) => w.message.includes('did not echo service_tier')),
    ).toBe(true)
    expect(sink.records[0]?.costMicroUsd).toBeNull()
  })

  it('an explicit fast request whose failed response echoes no tier is unpriced on the billed failure', async () => {
    const { client, sink } = clientFor(
      responseObject([], {
        status: 'failed',
        serviceTier: null,
        usage: usage(1_000, 100),
        error: { code: 'invalid_prompt', message: 'doc-derived' },
      }),
      'response.failed',
    )
    const err = (await client.generate(call, auth).catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.usage?.details['service_tier_missing']).toBe(1)
    expect(sink.records[0]?.costMicroUsd).toBeNull()
    expect(sink.records[0]?.costUnpricedReason).toContain('did not echo service_tier')
  })

  it('an echoed "default" on a fast request is priced at the standard rate (the documented downgrade)', async () => {
    const { client } = clientFor(
      responseObject([messageItem('msg_1', 'ok')], {
        serviceTier: 'default',
        usage: usage(1_000, 100),
      }),
    )
    const result = await client.generate(call, auth)
    // 1,000 × $2/M + 100 × $10/M
    expect(result.cost?.microUsd).toBe(3_000)
    expect(result.servedServiceTier).toBe('default')
  })

  it('an echoed "priority" is kept verbatim and priced at the Fast table', async () => {
    const { client } = clientFor(
      responseObject([messageItem('msg_1', 'ok')], {
        serviceTier: 'priority',
        usage: usage(1_000, 100),
      }),
    )
    const result = await client.generate(call, auth)
    expect(result.servedServiceTier).toBe('priority')
    expect(result.cost?.microUsd).toBe(6_000)
  })

  it('an unknown echoed tier is unpriced and kept verbatim', async () => {
    const { client } = clientFor(
      responseObject([messageItem('msg_1', 'ok')], {
        serviceTier: 'scale',
        usage: usage(1_000, 100),
      }),
    )
    const result = await client.generate(call, auth)
    expect(result.servedServiceTier).toBe('scale')
    expect(result.cost?.microUsd).toBeNull()
  })
})
