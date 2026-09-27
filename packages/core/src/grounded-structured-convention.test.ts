/**
 * Phase 5 adoption docs support test.
 *
 * Verifies that the grounded->structured pattern can be correlated by the same
 * `metadata.operationId` on both attempts, with distinct attempt IDs.
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry } from './index.js'
import type { AdapterResult, Usage } from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makeTestPricingSource } from './test-pricing-source.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const TEST_AUTH = { apiKey: 'test-key' }
const PRICING = makeTestPricingSource(
  {
    'gemini-2.5-pro': {
      standard: {
        inputPerM: 1_250_000,
        cachedPerM: 125_000,
        outputPerM: 10_000_000,
      },
      flex: {
        inputPerM: 625_000,
        cachedPerM: 62_500,
        outputPerM: 5_000_000,
      },
    },
    'gemini-2.5-flash': {
      standard: { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    },
  },
  'test-pricing-1',
)
const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
  makePermissiveTestDescriptor({ model: 'gemini-2.5-flash', provider: 'google' }),
])

const GOOD_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  details: {},
  raw: null,
}

function makeSuccessResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    text: 'Hello, world!',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-pro',
    modelVersion: 'gemini-2.5-pro-001',
    finishReason: 'stop',
    responseId: 'resp-abc123',
    warnings: [],
    ...overrides,
  }
}

describe('grounded-structured correlation convention', () => {
  it('links research and synthesis attempts with metadata.operationId', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        new FakeAdapter('google', [
          makeSuccessResult({ text: 'grounded findings' }),
          makeSuccessResult({ rawStructured: { summary: 'ok' } }),
        ]),
      ],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const operationId = 'op-2026-01'

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Research sources' }] }],
        metadata: {
          operationId,
          workflowId: 'workflow-123',
          phase: 'research',
        },
        config: {
          serviceTier: 'flex',
        },
      },
      { auth: TEST_AUTH },
    )

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: 'Turn research into JSON shape' }],
          },
        ],
        output: {
          jsonSchema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
            },
            required: ['summary'],
          },
        },
        metadata: {
          operationId,
          workflowId: 'workflow-123',
          phase: 'synthesis',
        },
      },
      { auth: TEST_AUTH },
    )

    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]?.attemptId).not.toBe(sink.records[1]?.attemptId)

    const firstMeta = sink.records[0]!.metadata as { operationId?: unknown }
    const secondMeta = sink.records[1]!.metadata as { operationId?: unknown }
    expect(firstMeta.operationId).toBe(operationId)
    expect(secondMeta.operationId).toBe(operationId)
  })
})
