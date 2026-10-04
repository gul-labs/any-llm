/**
 * Caller-owned structured-output validation helper tests.
 *
 * These tests prove the two failure modes that the core pipeline leaves to callers:
 * 1) parsed but wrong shape, and 2) malformed / unparseable structured output.
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, type StandardSchemaV1 } from './index.js'
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
    },
  },
  'test-pricing-1',
)
const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])

type StructuredValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      reason: 'not_parsed' | 'shape_invalid'
      issues?: readonly StandardSchemaV1.Issue[]
    }

async function validateStructuredResult<T>(
  result: { output?: unknown; outputParsed?: boolean },
  schema: StandardSchemaV1<unknown, T>,
): Promise<StructuredValidationResult<T>> {
  if (result.outputParsed !== true) {
    return { ok: false, reason: 'not_parsed' }
  }

  const parsed = await schema['~standard'].validate(result.output)
  if ('issues' in parsed) {
    return parsed.issues !== undefined
      ? { ok: false, reason: 'shape_invalid', issues: parsed.issues }
      : { ok: false, reason: 'shape_invalid' }
  }

  return { ok: true, value: parsed.value }
}

const GOOD_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  details: {},
  raw: null,
}

function makeSuccessResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'Hello, world!' }] },
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

const summarySchema: StandardSchemaV1<{ summary?: string }, { summary: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test/summary',
    validate(value) {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { summary?: unknown }).summary === 'string'
      ) {
        return { value: { summary: (value as { summary: string }).summary } }
      }
      return { issues: [{ message: 'summary must be a string' }] }
    },
    types: {
      input: {},
      output: { summary: '' },
    },
  },
}

const summaryAndCitationsSchema: StandardSchemaV1<
  { summary?: unknown; citations?: unknown },
  { summary: string; citations: unknown[] }
> = {
  '~standard': {
    version: 1,
    vendor: 'test/summary-and-citations',
    validate(value) {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { summary?: unknown }).summary === 'string' &&
        Array.isArray((value as { citations?: unknown }).citations)
      ) {
        return {
          value: {
            summary: (value as { summary: string }).summary,
            citations: (value as { citations: unknown[] }).citations,
          },
        }
      }
      return {
        issues: [{ message: 'summary must be a string and citations must be an array' }],
      }
    },
    types: {
      input: { citations: [] as unknown[] },
      output: { summary: '', citations: [] as unknown[] },
    },
  },
}

describe('caller-owned structured-output validation helper', () => {
  it('returns shape_invalid when output parses but fails schema validation', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        new FakeAdapter(
          'google',
          makeSuccessResult({ rawStructured: { unexpected: 'shape' } }),
        ),
      ],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Score?' }] }],
        output: {
          jsonSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
      { auth: TEST_AUTH },
    )

    expect(result.outputParsed).toBe(true)
    const validation = await validateStructuredResult(result, summarySchema)

    expect(validation).toMatchObject({ ok: false, reason: 'shape_invalid' })
    if (validation.ok) expect.fail('expected validation to fail')
    expect(validation.issues?.length).toBeGreaterThanOrEqual(1)
  })

  it('returns not_parsed and skips validation when output JSON was malformed', async () => {
    let validateCalled = false
    const noParseSchema: StandardSchemaV1<{ summary?: string }, { summary: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test/no-parse',
        validate() {
          validateCalled = true
          return { value: { summary: 'unreachable' } }
        },
      },
    }

    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink: new RecordingSink(),
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'No JSON available' }] },
        ],
        output: {
          jsonSchema: {
            type: 'object',
            properties: { summary: { type: 'string' } },
            required: ['summary'],
          },
        },
      },
      { auth: TEST_AUTH },
    )

    const validation = await validateStructuredResult(result, noParseSchema)
    expect(result.outputParsed).toBe(false)
    expect(validation).toEqual({ ok: false, reason: 'not_parsed' })
    expect(validateCalled).toBe(false)

    // Uses a second hand-rolled schema as part of the adoption test shape.
    const citationValidation = await validateStructuredResult(
      result,
      summaryAndCitationsSchema,
    )
    if (citationValidation.ok) expect.fail('expected validation to fail')
    expect(citationValidation.reason).toBe('not_parsed')
    expect(citationValidation).toEqual({ ok: false, reason: 'not_parsed' })
  })
})
