/**
 * Engine integration tests for {@link Client.countTokens}.
 *
 * Mirrors the conventions in `engine.test.ts` (FakeClock, FakeIds,
 * RecordingSink, makePermissiveTestDescriptor, TEST_AUTH shape).  Since
 * `FakeAdapter` from `@gullabs/testing` implements only `run`, a tiny local
 * fake adapter implementing `ProviderAdapter` (`id`, `run`, `countTokens`) is
 * used here to exercise the `countTokens` seam.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  TokenCountRequest,
  TokenCount,
  Logger,
} from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])
const TEST_AUTH = { apiKey: 'test-key' }

/**
 * A minimal {@link ProviderAdapter} implementing `countTokens` alongside a
 * no-op `run`, for exercising the engine's `countTokens` seam without pulling
 * in a full FakeAdapter script.
 */
class CountTokensFakeAdapter implements ProviderAdapter {
  readonly id: string
  readonly countTokensCalls: Array<{ req: TokenCountRequest; ctx: AdapterCtx }> = []
  private readonly result: TokenCount | Error

  constructor(id: string, result: TokenCount | Error) {
    this.id = id
    this.result = result
  }

  async run(_req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
    throw new Error('CountTokensFakeAdapter.run should not be called in these tests')
  }

  async countTokens(req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> {
    this.countTokensCalls.push({ req, ctx })
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

function makeReq(overrides?: Partial<TokenCountRequest>): TokenCountRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
    ...overrides,
  }
}

describe('engine.countTokens — happy path', () => {
  it('returns the TokenCount verbatim from the adapter', async () => {
    const tokenCount: TokenCount = {
      totalTokens: 42,
      accuracy: 'exact',
      details: { cached: 10 },
      raw: null,
    }
    const adapter = new CountTokensFakeAdapter('google', tokenCount)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.countTokens(makeReq(), { auth: TEST_AUTH })
    expect(result).toEqual(tokenCount)
    expect(adapter.countTokensCalls).toHaveLength(1)
  })
})

describe('engine.countTokens — validation errors', () => {
  it('unregistered (provider, model) → bad_request', async () => {
    const adapter = new CountTokensFakeAdapter('google', {
      totalTokens: 1,
      accuracy: 'exact',
      raw: null,
    })
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.countTokens(makeReq({ model: 'no-such-model' }), { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('No registered model'),
    })
  })

  it('adapter without countTokens → bad_request naming the provider', async () => {
    const plainAdapter = new FakeAdapter('google', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
      text: 'hi',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'gemini-2.5-pro',
      warnings: [],
    })
    const client = createClient({
      adapters: [plainAdapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.countTokens(makeReq(), { auth: TEST_AUTH }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('"google"'),
    })
  })

  it('missing opts.auth → same invalid_auth error as generate()', async () => {
    const adapter = new CountTokensFakeAdapter('google', {
      totalTokens: 1,
      accuracy: 'exact',
      raw: null,
    })
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect((client.countTokens as any)(makeReq())).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
    await expect((client.countTokens as any)(makeReq())).rejects.toBeInstanceOf(LlmError)
  })
})

describe('engine.countTokens — signal propagation', () => {
  it('forwards opts.signal to ctx.signal unchanged', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    const adapter = new (class implements ProviderAdapter {
      readonly id = 'google'
      async run(): Promise<AdapterResult> {
        throw new Error('unused')
      }
      async countTokens(_req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> {
        capturedSignal = ctx.signal
        return { totalTokens: 5, accuracy: 'exact', raw: null }
      }
    })()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.countTokens(makeReq(), { auth: TEST_AUTH, signal: controller.signal })
    expect(capturedSignal).toBe(controller.signal)
  })
})

describe('engine.countTokens — logger events', () => {
  it('emits llm.count_tokens.start / .success on the success path', async () => {
    const infoFn = vi.fn()
    const logger: Logger = { info: infoFn, warn() {}, error() {}, debug() {} }
    const adapter = new CountTokensFakeAdapter('google', {
      totalTokens: 7,
      accuracy: 'exact',
      raw: null,
    })
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      logger,
    })

    await client.countTokens(makeReq(), { auth: TEST_AUTH })

    const messages = infoFn.mock.calls.map((c) => c[1])
    expect(messages).toContain('llm.count_tokens.start')
    expect(messages).toContain('llm.count_tokens.success')
  })

  it('emits llm.count_tokens.error on the failure path', async () => {
    const errorFn = vi.fn()
    const logger: Logger = { info() {}, warn() {}, error: errorFn, debug() {} }
    const adapterErr = new LlmError('boom', { kind: 'server', retryable: true })
    const adapter = new CountTokensFakeAdapter('google', adapterErr)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      logger,
    })

    await expect(
      client.countTokens(makeReq(), { auth: TEST_AUTH }),
    ).rejects.toMatchObject({ kind: 'server' })

    const messages = errorFn.mock.calls.map((c) => c[1])
    expect(messages).toContain('llm.count_tokens.error')
  })
})

describe('engine.countTokens — no sink writes', () => {
  it('does not write any sink record on a successful call', async () => {
    const sink = new RecordingSink()
    const adapter = new CountTokensFakeAdapter('google', {
      totalTokens: 3,
      accuracy: 'exact',
      raw: null,
    })
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      sink,
    })

    await client.countTokens(makeReq(), { auth: TEST_AUTH })
    expect(sink.records).toHaveLength(0)
  })

  it('does not write any sink record on the error path either', async () => {
    const sink = new RecordingSink()
    const adapterErr = new LlmError('boom', { kind: 'server', retryable: true })
    const adapter = new CountTokensFakeAdapter('google', adapterErr)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      sink,
    })

    await expect(
      client.countTokens(makeReq(), { auth: TEST_AUTH }),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(sink.records).toHaveLength(0)
  })
})
