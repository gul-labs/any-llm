/**
 * Async validators that run inside a call (the request's `inputContract` and the
 * per-attempt config validation) are bounded by the call: a validator that never
 * settles ends at `timeoutMs` or at the caller's abort, and a deadline that passes
 * while a validator holds the call is re-checked before the provider is reached.
 *
 * Fake timers move the engine's default clock (`Date.now`) too.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createModelRegistry, defineCallSite } from './index.js'
import type { AdapterResult, LlmRequest, Middleware } from './index.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import { FakeAdapter, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const AUTH = { apiKey: 'test-key' }
const NEVER = (): Promise<never> => new Promise<never>(() => {})

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'gemini-2.5-pro',
  warnings: [],
}

function schemaOf(validate: (value: unknown) => unknown): StandardSchemaV1 {
  return {
    '~standard': { version: 1, vendor: 'test', validate: validate as never },
  }
}

/**
 * A model whose config validator accepts the call-level pass (the first call) and
 * then behaves as `afterFirst` says, which is what each attempt runs.
 */
function registryWithAttemptValidator(afterFirst: (config: unknown) => unknown) {
  let calls = 0
  const descriptor = {
    ...makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
    validateConfig: schemaOf((config) =>
      calls++ === 0 ? { value: config } : afterFirst(config),
    ),
  }
  return createModelRegistry([descriptor as never])
}

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: { timeoutMs: 1000 },
    ...over,
  }
}

function observe<T>(promise: Promise<T>): { settled: boolean; error?: unknown } {
  const o: { settled: boolean; error?: unknown } = { settled: false }
  void promise.then(
    () => {
      o.settled = true
    },
    (e: unknown) => {
      o.settled = true
      o.error = e
    },
  )
  return o
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a pending inputContract validator', () => {
  const pending: LlmRequest['inputContract'] = { schema: schemaOf(NEVER), value: {} }

  it('generate ends at timeoutMs and never reaches the middleware or the adapter', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const sink = new RecordingSink()
    const seen: string[] = []
    const spy: Middleware = {
      id: 'spy',
      intercept(req, ctx, next) {
        seen.push('intercept')
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      middleware: [spy],
    })
    const outcome = observe(
      client.generate(request({ inputContract: pending! }), { auth: AUTH }),
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(adapter.calls).toHaveLength(0)
    expect(seen).toEqual([])
    expect(sink.records).toHaveLength(1)
  })

  it('generate ends at the caller abort', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({ adapters: [adapter], modelRegistry: REGISTRY })
    const controller = new AbortController()
    const outcome = observe(
      client.generate(request({ inputContract: pending! }), {
        auth: AUTH,
        signal: controller.signal,
      }),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(outcome.settled).toBe(false)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(adapter.calls).toHaveLength(0)
  })

  it('generate without a timeout still ends at the caller abort', async () => {
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({ adapters: [adapter], modelRegistry: REGISTRY })
    const controller = new AbortController()
    const outcome = observe(
      client.generate(
        { ...request({ inputContract: pending! }), config: {} },
        { auth: AUTH, signal: controller.signal },
      ),
    )
    controller.abort()
    await expect.poll(() => outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
  })

  it('a validator that blocks past the deadline does not hand a spent call to the middleware', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const seen: string[] = []
    const spy: Middleware = {
      id: 'spy',
      intercept(req, ctx, next) {
        seen.push('intercept')
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [spy],
    })
    const slow = schemaOf(() => {
      // Blocks the event loop past the deadline: the timer has not run.
      vi.setSystemTime(Date.now() + 5000)
      return { value: {} }
    })
    const error = await client
      .generate(request({ inputContract: { schema: slow, value: {} } }), { auth: AUTH })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(seen).toEqual([])
    expect(adapter.calls).toHaveLength(0)
  })
})

describe('a pending per-attempt config validator', () => {
  it('generate ends at timeoutMs with the attempt in the ledger and no dispatch', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator(NEVER),
      sink,
    })
    const outcome = observe(client.generate(request(), { auth: AUTH }))

    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(1)
    expect(sink.last()).toMatchObject({ status: 'timeout', errorKind: 'timeout' })
  })

  it('generate ends at the caller abort', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator(NEVER),
    })
    const controller = new AbortController()
    const outcome = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(outcome.settled).toBe(false)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(adapter.calls).toHaveLength(0)
  })

  const callSite = defineCallSite({
    id: 'cs',
    provider: 'google',
    model: 'gemini-2.5-pro',
    userTemplate: 'hi',
    config: { timeoutMs: 1000 },
  })

  it('runStructured ends at timeoutMs', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator(NEVER),
    })
    const outcome = observe(client.runStructured(callSite, {}, { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(adapter.calls).toHaveLength(0)
  })

  it('runStructured ends at the caller abort', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator(NEVER),
    })
    const controller = new AbortController()
    const outcome = observe(
      client.runStructured(callSite, {}, { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(outcome.settled).toBe(false)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.settled).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(adapter.calls).toHaveLength(0)
  })

  it('a validator that blocks past the deadline never dispatches', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator((config) => {
        vi.setSystemTime(Date.now() + 5000)
        return { value: config }
      }),
    })
    const error = await client
      .generate(request(), { auth: AUTH })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(adapter.calls).toHaveLength(0)
  })

  it('a settling validator is unaffected', async () => {
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registryWithAttemptValidator(async (config) => ({ value: config })),
    })
    await expect(client.generate(request(), { auth: AUTH })).resolves.toMatchObject({
      text: 'ok',
    })
    expect(adapter.calls).toHaveLength(1)
  })
})
