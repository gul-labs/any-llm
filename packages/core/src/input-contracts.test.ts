/**
 * Tests for input-contracts commits C1 and C2:
 * - D1 (strict template interpolation)
 * - D2 (`CallSite.inputSchema`)
 * - D3 (`LlmRequest.inputContract`)
 * - D4 (`createClient({ requireInputContract: true })`)
 * - D5 (generic pre-attempt ledger record)
 * - their interaction with D6 (`issues`)
 *
 * D6's own normalization/drift-pinning tests live in errors.test.ts (unit
 * level) and engine.test.ts (config-validation integration level).
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  createClient,
  createModelRegistry,
  defineCallSite,
  LlmError,
  errorKindToStatus,
} from './index.js'
import type {
  AdapterResult,
  Usage,
  Middleware,
  ResolvedRequest,
  EngineCtx,
  Handler,
} from './index.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { zodToStandardSchema } from './model-config/index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'

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
    'gemini-2.5-flash': { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
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
// D1 — strict template interpolation
// ---------------------------------------------------------------------------

describe('D1 — strict template interpolation', () => {
  it('unresolved placeholder in userTemplate throws bad_request, not retryable, with issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-user',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'name' }],
      },
    )
    expect(adapter.calls).toHaveLength(0)
  })

  it('unresolved placeholder in system template throws bad_request with issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-system',
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'You serve {{tenant}}.',
      userTemplate: 'Hi',
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'tenant' }],
      },
    )
    expect(adapter.calls).toHaveLength(0)
  })

  it('unresolved placeholders in both templates: violations from both surface in one error', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-both',
      provider: 'google',
      model: 'gemini-2.5-flash',
      system: 'System for {{tenant}}.',
      userTemplate: 'Hello {{name}}',
    })

    const err = await client.runStructured(cs, {}, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    const paths = (err.issues as Array<{ path: string }>).map((i) => i.path).sort()
    expect(paths).toEqual(['name', 'tenant'])
    expect(adapter.calls).toHaveLength(0)
  })

  it('null value for a placeholder is a violation', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-null',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(
      client.runStructured(cs, { name: null as unknown as string }, { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('undefined value for a placeholder is a violation', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-undefined',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await expect(
      client.runStructured(
        cs,
        { name: undefined as unknown as string },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('non-string value (number) is a violation — never coerced', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-number',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Age: {{age}}',
    })

    await expect(
      client.runStructured(cs, { age: 30 as unknown as string }, { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'age' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('non-string value (object) is a violation — never coerced', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-object',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Data: {{data}}',
    })

    await expect(
      client.runStructured(
        cs,
        { data: { nested: true } as unknown as string },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'data' }],
    })
    expect(adapter.calls).toHaveLength(0)
  })

  it('multiple violations are all reported in one error (not just the first)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-multi',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{first}} {{second}} {{third}}',
    })

    const err = await client
      .runStructured(cs, { second: 42 as unknown as string }, { auth: TEST_AUTH })
      .catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    const paths = (err.issues as Array<{ path: string }>).map((i) => i.path).sort()
    expect(paths).toEqual(['first', 'second', 'third'])
    expect(err.message).toContain('{{first}}')
    expect(err.message).toContain('{{second}}')
    expect(err.message).toContain('{{third}}')
    expect(adapter.calls).toHaveLength(0)
  })

  it('unused extra vars are allowed (shared context bag across call sites)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-extra',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
    })

    await client.runStructured(
      cs,
      { name: 'Ada', unusedInThisTemplate: 'whatever' },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('Hello Ada')
  })

  it('a call site with no templates is unchanged by D1', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-no-template',
      provider: 'google',
      model: 'gemini-2.5-flash',
    })

    await client.runStructured(cs, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('')
  })

  it('a template with no {{ is unchanged by D1', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-plain',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Plain text, no placeholders here.',
    })

    await client.runStructured(cs, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
    const part = adapter.calls[0]!.messages[0]?.parts[0] as { text: string }
    expect(part.text).toBe('Plain text, no placeholders here.')
  })
})

// ---------------------------------------------------------------------------
// D2 — CallSite.inputSchema
// ---------------------------------------------------------------------------

describe('D2 — CallSite.inputSchema', () => {
  const VarsSchema = z.object({
    name: z.string().min(1),
    age: z.string(),
  })

  it('valid vars pass through to the adapter', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-valid',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}, age {{age}}',
      inputSchema: zodToStandardSchema(VarsSchema),
    })

    await client.runStructured(cs, { name: 'Ada', age: '30' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })

  it('invalid vars throw bad_request with every failing path in issues', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-invalid',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}, age {{age}}',
      inputSchema: zodToStandardSchema(VarsSchema),
    })

    const err = await client
      .runStructured(cs, { name: '', age: '30' }, { auth: TEST_AUTH })
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect((err.issues as Array<{ path: string }>).map((i) => i.path)).toEqual(['name'])
    expect(adapter.calls).toHaveLength(0)
  })

  it('async validators are supported', async () => {
    const asyncSchema: StandardSchemaV1<Record<string, string>> = {
      '~standard': {
        version: 1,
        vendor: 'test-async',
        async validate(value: unknown) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          const v = value as Record<string, string>
          if (v['name'] === undefined) {
            return { issues: [{ message: 'name is required', path: ['name'] }] }
          }
          return { value: v }
        },
      },
    }

    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-async',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
      inputSchema: asyncSchema,
    })

    await expect(client.runStructured(cs, {}, { auth: TEST_AUTH })).rejects.toMatchObject(
      { kind: 'bad_request', retryable: false, issues: [{ path: 'name' }] },
    )
    expect(adapter.calls).toHaveLength(0)

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })

  it('D2 runs before D1: a field missing from BOTH the schema and the template surfaces as the schema error', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-ordering',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
      inputSchema: zodToStandardSchema(z.object({ name: z.string().min(1) })),
    })

    // 'name' is both required by the schema AND referenced by the template.
    // Omitting it entirely must surface as the schema's own error (D2),
    // never as a D1 unresolved-placeholder violation.
    const err = await client.runStructured(cs, {}, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.issues[0].path).toBe('name')
    // Distinguish the D2 message shape ("vars.<path>") from the D1 shape
    // ("has unresolved template placeholder(s)").
    expect(err.message).toContain('vars.name')
    expect(err.message).not.toContain('unresolved template placeholder')
    expect(adapter.calls).toHaveLength(0)
  })

  it('schema validator is invoked exactly once (no double validation)', async () => {
    const validate = vi.fn((value: unknown) => ({
      value: value as Record<string, string>,
    }))
    const schema: StandardSchemaV1<Record<string, string>> = {
      '~standard': { version: 1, vendor: 'test-count', validate },
    }

    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-once',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi {{name}}',
      inputSchema: schema,
    })

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('two-arg overload (vars defaulted to {}) still runs D2: schema issues surface', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-two-arg',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hello {{name}}',
      inputSchema: zodToStandardSchema(z.object({ name: z.string().min(1) })),
    })

    // No vars argument: runStructured defaults vars to {} — the inputSchema
    // must still be enforced on that defaulted bag, and its violation must be
    // the schema's own error (D2 message shape), not a D1 placeholder error.
    const err = await client.runStructured(cs, { auth: TEST_AUTH }).catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect((err.issues as Array<{ path: string }>).map((i) => i.path)).toEqual(['name'])
    expect(err.message).toContain('vars.name')
    expect(err.message).not.toContain('unresolved template placeholder')
    expect(adapter.calls).toHaveLength(0)
  })

  it('inputSchema absent → no D2 validation performed (unchanged behavior)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)
    const cs = defineCallSite({
      id: 'cs-none',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi {{name}}',
    })

    await client.runStructured(cs, { name: 'Ada' }, { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// D3 — LlmRequest.inputContract
// ---------------------------------------------------------------------------

describe('D3 — LlmRequest.inputContract', () => {
  const ValueSchema = zodToStandardSchema(z.object({ orderId: z.string().min(1) }))

  function makeRequest() {
    return {
      provider: 'google',
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] },
      ],
    }
  }

  it('violation throws bad_request with issues + callId', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const err = await client
      .generate(
        {
          ...makeRequest(),
          inputContract: { schema: ValueSchema, value: { orderId: '' } },
        },
        { auth: TEST_AUTH },
      )
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect((err.issues as Array<{ path: string }>).map((i) => i.path)).toEqual([
      'orderId',
    ])
    expect(err.callId).toBeDefined()
    expect(adapter.calls).toHaveLength(0)
  })

  it('runs before middleware — a counting middleware observes zero invocations on refusal', async () => {
    const adapter = new FakeAdapter('google', successResult())
    let invocations = 0
    const countingMiddleware: Middleware = {
      id: 'counting',
      async intercept(req: ResolvedRequest, ctx: EngineCtx, next: Handler) {
        invocations++
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink: new RecordingSink(),
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [countingMiddleware],
    })

    await client
      .generate(
        {
          ...makeRequest(),
          inputContract: { schema: ValueSchema, value: { orderId: '' } },
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(invocations).toBe(0)
    expect(adapter.calls).toHaveLength(0)
  })

  it('validated exactly once — not per retry attempt', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const validate = vi.fn(() => ({
      issues: [{ message: 'always invalid', path: ['orderId'] }],
    }))
    const schema: StandardSchemaV1<unknown> = {
      '~standard': { version: 1, vendor: 'test-count', validate },
    }
    const { retryMiddleware } = await import('./index.js')
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink: new RecordingSink(),
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
    })

    await client
      .generate(
        { ...makeRequest(), inputContract: { schema, value: { orderId: '' } } },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(validate).toHaveBeenCalledTimes(1)
    expect(adapter.calls).toHaveLength(0)
  })

  it('valid contract dispatches normally', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const result = await client.generate(
      {
        ...makeRequest(),
        inputContract: { schema: ValueSchema, value: { orderId: 'ord-1' } },
      },
      { auth: TEST_AUTH },
    )

    expect(result.text).toBe('result text')
    expect(adapter.calls).toHaveLength(1)
  })

  it('inputContract absent → no validation performed', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    await client.generate(makeRequest(), { auth: TEST_AUTH })
    expect(adapter.calls).toHaveLength(1)
  })

  it('adapter never receives inputContract — pinned on the exact ResolvedRequest keys', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    await client.generate(
      {
        ...makeRequest(),
        inputContract: { schema: ValueSchema, value: { orderId: 'ord-1' } },
      },
      { auth: TEST_AUTH },
    )

    expect(adapter.calls).toHaveLength(1)
    const seenReq = adapter.calls[0]!
    expect('inputContract' in seenReq).toBe(false)
    expect(Object.keys(seenReq).sort()).toEqual(
      ['config', 'messages', 'model', 'modelDescriptor', 'provider'].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// D4 — createClient({ requireInputContract: true })
// ---------------------------------------------------------------------------

describe('D4 — requireInputContract', () => {
  it('on → generate() without inputContract is refused, WITH a ledger row', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      requireInputContract: true,
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.attemptNumber).toBe(0)
    expect(sink.records[0]!.callId).toBe(err.callId)
  })

  it('on → runStructured() without inputSchema is refused, row-less', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      requireInputContract: true,
    })
    const cs = defineCallSite({
      id: 'cs-no-schema',
      provider: 'google',
      model: 'gemini-2.5-flash',
      userTemplate: 'Hi',
    })

    const err = await client.runStructured(cs, {}, { auth: TEST_AUTH }).catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(0)
  })

  it('off/absent → unchanged behavior (no contract required)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const client = makeClient(adapter)

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )
    expect(result.text).toBe('result text')
  })

  it('precedence: missing contract AND unregistered model → unregistered-model error, row-less', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      requireInputContract: true,
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'nonexistent-model',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.message).toContain('No registered model')
    expect(sink.records).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// D5 — generic pre-attempt ledger record
// ---------------------------------------------------------------------------

describe('D5 — generic pre-attempt ledger record', () => {
  const ValueSchema = zodToStandardSchema(z.object({ orderId: z.string().min(1) }))

  it('D3 refusal writes exactly one record with a minted attemptId', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(1000),
      ids: new FakeIds(),
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          inputContract: { schema: ValueSchema, value: { orderId: '' } },
        },
        { auth: TEST_AUTH },
      )
      .catch((e) => e)

    expect(sink.records).toHaveLength(1)
    const record = sink.records[0]!
    expect(record.status).toBe('api_error')
    expect(record.status).toBe(errorKindToStatus('bad_request'))
    expect(record.errorKind).toBe('bad_request')
    expect(record.inputTokens).toBe(0)
    expect(record.outputTokens).toBe(0)
    expect(record.costMicroUsd).toBeUndefined()
    expect(record.pricingVersion).toBeUndefined()
    expect(record.attemptNumber).toBe(0)
    // Minted — no idempotencyKey was supplied.
    expect(record.attemptId).toBe('attempt_1')
    expect(record.callId).toBe(err.callId)
    expect(record.provider).toBe('google')
    expect(record.model).toBe('gemini-2.5-flash')
    expect(record.createdAt).toBe(new Date(1000).toISOString())
  })

  it('D3 refusal with idempotencyKey supplied uses it verbatim as attemptId', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          inputContract: { schema: ValueSchema, value: { orderId: '' } },
          idempotencyKey: 'idem-key-1',
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.attemptNumber).toBe(0)
    expect(sink.records[0]!.attemptId).toBe('idem-key-1')
  })

  it('quota-style rate_limited middleware refusal pre-attempt writes one row', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const quotaLikeMiddleware: Middleware = {
      id: 'quota-like',
      intercept(): Promise<never> {
        throw new LlmError('quota exceeded', { kind: 'rate_limited', retryable: true })
      },
    }
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [quotaLikeMiddleware],
    })

    await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.errorKind).toBe('rate_limited')
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[0]!.attemptNumber).toBe(0)
    expect(adapter.calls).toHaveLength(0)
  })

  it('a GENERIC custom middleware throwing any pre-attempt LlmError also writes one row (source-agnostic)', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const genericRefuser: Middleware = {
      id: 'generic-refuser',
      intercept(): Promise<never> {
        throw new LlmError('refused before dispatch', { kind: 'server', retryable: true })
      },
    }
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [genericRefuser],
    })

    await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.errorKind).toBe('server')
    expect(sink.records[0]!.attemptNumber).toBe(0)
  })

  it('post-attempt errors produce no synthetic row — no duplicates', async () => {
    const adapter = new FakeAdapter('google', [
      new LlmError('bad input', { kind: 'bad_request', retryable: false }),
    ])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    // Exactly one record — the real per-attempt error record from runAttempt.
    // No additional synthetic attemptNumber:0 row.
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.attemptNumber).toBe(1)
    expect(adapter.calls).toHaveLength(1)
  })

  it('pre-callId errors produce no row', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client
      .generate(
        {
          provider: 'google',
          model: 'nonexistent-model',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch(() => {})

    expect(sink.records).toHaveLength(0)
  })

  it('sink failure on the pre-attempt path is fail-open — the original error still throws', async () => {
    const adapter = new FakeAdapter('google', successResult())
    const sink = new RecordingSink({ failOnRecord: true })
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
          inputContract: { schema: ValueSchema, value: { orderId: '' } },
        },
        { auth: TEST_AUTH },
      )
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    // No records captured — the sink rejected every write — but the call
    // still surfaced the ORIGINAL bad_request error, not a sink error.
    expect(sink.records).toHaveLength(0)
  })
})
