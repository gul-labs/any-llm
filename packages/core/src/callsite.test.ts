/**
 * Call-site tests for @gullabs/core.
 *
 * Tests defineCallSite + client.runStructured: template rendering, config
 * resolution, structured-output hint forwarding, callSiteId propagation.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, defineCallSite, LlmError } from './index.js'
import type { AdapterResult, Usage } from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makeTestPricingSource } from './test-pricing-source.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GOOD_USAGE: Usage = {
  inputTokens: 50,
  outputTokens: 10,
  details: {},
  raw: null,
}

function successResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'result text' }] },
    text: 'result text',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-flash',
    warnings: [],
    ...overrides,
  }
}

const TEST_AUTH = { apiKey: 'test-key' }
const PRICING = makeTestPricingSource(
  {
    'gemini-2.5-flash': {
      standard: { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    },
  },
  'test-pricing-1',
)
const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-flash', provider: 'google' }),
])

function makeClient(adapter: FakeAdapter, sink?: RecordingSink) {
  return createClient({
    adapters: [adapter],
    pricingSources: { google: PRICING },
    modelRegistry: TEST_REGISTRY,
    sink: sink ?? new RecordingSink(),
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
}

// ---------------------------------------------------------------------------
// defineCallSite
// ---------------------------------------------------------------------------

describe('defineCallSite', () => {
  it('returns the options object unchanged', () => {
    const opts = {
      id: 'my-site',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    }
    expect(defineCallSite(opts)).toBe(opts)
  })

  it('preserves jsonSchema on the call site', () => {
    const jsonSchema = { type: 'object', properties: { count: { type: 'number' } } }
    const cs = defineCallSite({
      id: 'x',
      provider: 'google',
      model: 'gemini-2.5-flash',
      jsonSchema,
    })
    expect(cs.jsonSchema).toBe(jsonSchema)
  })
})

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe('runStructured — template rendering', () => {
  it('renders {{var}} placeholders in userTemplate', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'greet',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello, {{name}}! You are {{age}} years old.',
    })

    await client.runStructured(cs, { name: 'Alice', age: '30' }, { auth: TEST_AUTH })

    const req = adapter.calls[0]!
    const part = req.messages[0]?.parts[0] as { kind: string; text: string }
    expect(part.text).toBe('Hello, Alice! You are 30 years old.')
  })

  it('renders {{var}} in system template', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'sys',
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'You are a bot for {{company}}.',
      userTemplate: 'Hello',
    })

    await client.runStructured(cs, { company: 'Acme Corp' }, { auth: TEST_AUTH })

    const req = adapter.calls[0]!
    expect(req.system).toBe('You are a bot for Acme Corp.')
  })

  it('D1: throws bad_request naming the callsite id and the unresolved placeholder; adapter never invoked', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'missing',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Greet {{name}} and {{unknown}}',
    })

    // Only provide 'name', not 'unknown' — strict interpolation refuses the call.
    await expect(
      client.runStructured(cs, { name: 'Bob' }, { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'unknown' }],
    })
    await expect(
      client.runStructured(cs, { name: 'Bob' }, { auth: TEST_AUTH }),
    ).rejects.toBeInstanceOf(LlmError)
    await expect(
      client.runStructured(cs, { name: 'Bob' }, { auth: TEST_AUTH }),
    ).rejects.toThrow(/Call site "missing"/)
    await expect(
      client.runStructured(cs, { name: 'Bob' }, { auth: TEST_AUTH }),
    ).rejects.toThrow(/\{\{unknown\}\}/)

    expect(adapter.calls).toHaveLength(0)
  })

  it('non-recursive: var value containing {{x}} is NOT expanded', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'inject',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Input: {{data}}',
    })

    // Anti-injection: the value '{{secret}}' must appear literally, not be expanded
    await client.runStructured(cs, { data: '{{secret}}' }, { auth: TEST_AUTH })

    const req = adapter.calls[0]!
    const part = req.messages[0]?.parts[0] as { kind: string; text: string }
    expect(part.text).toBe('Input: {{secret}}')
  })

  it('refuses a call site that renders an empty user message when there are no attachments', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = makeClient(adapter, sink)

    const cs = defineCallSite({
      id: 'empty',
      provider: 'google',
      model: 'gemini-2.5-flash',
    })
    await expect(client.runStructured(cs, { auth: TEST_AUTH })).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'userTemplate' }],
    })
    // Same for a template that renders to nothing.
    await expect(
      client.runStructured(
        { ...cs, userTemplate: '{{x}}' },
        { x: '' },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
    // Row-less, like the other prologue refusals.
    expect(sink.records).toHaveLength(0)
  })

  it('D1: no vars argument (two-arg overload → vars = {}) throws for any templated placeholder', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'novars',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(client.runStructured(cs, { auth: TEST_AUTH })).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name' }],
    })

    expect(adapter.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Call-site config resolution
// ---------------------------------------------------------------------------

describe('runStructured — config resolution', () => {
  it('libDefaults → callSite.config → opts.config (per-call wins)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      defaults: { temperature: 0.1, topP: 0.9 },
    })

    const cs = defineCallSite({
      id: 'cfg',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
      config: { temperature: 0.5 },
    })

    // Per-call overrides callSite
    await client.runStructured(cs, {}, { auth: TEST_AUTH, config: { temperature: 0.8 } })

    const req = adapter.calls[0]!
    // per-call temperature wins
    expect(req.config.temperature).toBe(0.8)
    // topP inherited from libDefaults (callSite didn't set it, per-call didn't either)
    expect(req.config.topP).toBe(0.9)
  })

  it('callSiteId is written to record', async () => {
    const sink = new RecordingSink()
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter, sink)

    const cs = defineCallSite({
      id: 'my-special-site',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
    })

    await client.runStructured(cs, { auth: TEST_AUTH })

    expect(sink.last()!.callSiteId).toBe('my-special-site')
  })

  it('metadata from opts is passed to record', async () => {
    const sink = new RecordingSink()
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter, sink)

    const cs = defineCallSite({
      id: 'meta',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
    })

    await client.runStructured(
      cs,
      {},
      {
        auth: TEST_AUTH,
        metadata: { tenantId: 'org-1', runId: 'run-42' },
      },
    )

    expect(sink.last()!.metadata).toEqual({ tenantId: 'org-1', runId: 'run-42' })
  })
})

// ---------------------------------------------------------------------------
// Structured output via runStructured
// ---------------------------------------------------------------------------

describe('runStructured — structured output', () => {
  it('valid rawStructured → outputParsed true', async () => {
    const jsonSchema = { type: 'object', properties: { label: { type: 'string' } } }
    const adapter = new FakeAdapter(
      'google',
      successResult({ rawStructured: { label: 'spam', score: 0.95 } }),
    )
    const client = makeClient(adapter)

    const cs = defineCallSite({
      id: 'classify',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
      jsonSchema,
    })

    const result = await client.runStructured(cs, { auth: TEST_AUTH })
    expect(result.output).toEqual({ label: 'spam', score: 0.95 })
    expect(result.outputParsed).toBe(true)
  })

  it('shape-mismatching rawStructured still succeeds; caller validates', async () => {
    const jsonSchema = { type: 'object', properties: { label: { type: 'string' } } }
    const adapter = new FakeAdapter(
      'google',
      successResult({ rawStructured: { label: 123 } }),
    )
    const sink = new RecordingSink()
    const client = makeClient(adapter, sink)

    const cs = defineCallSite({
      id: 'classify-bad',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
      jsonSchema,
    })

    const result = await client.runStructured(cs, { auth: TEST_AUTH })
    expect(result.output).toEqual({ label: 123 })
    expect(result.outputParsed).toBe(true)
    expect(sink.last()!.status).toBe('ok')
  })
})
