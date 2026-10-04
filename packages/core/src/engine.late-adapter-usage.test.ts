/**
 * A timeout or abort that wins the race over a dispatched adapter call still
 * keeps the usage the adapter's own failure carries a few microtasks later (an
 * estimate for a stream cut mid-answer): the attempt row is priced from it
 * instead of booked as an unpriced attempt.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import type {
  AdapterCtx,
  AdapterResult,
  LlmRequest,
  ProviderAdapter,
  ResolvedRequest,
  Usage,
} from './index.js'
import { RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])
const AUTH = { apiKey: 'test-key' }

const ESTIMATE: Usage = {
  inputTokens: 40,
  outputTokens: 2_500,
  details: { input: 40, output: 2_500 },
  raw: null,
}

const request = (timeoutMs?: number): LlmRequest => ({
  provider: 'google',
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
  ...(timeoutMs !== undefined ? { config: { timeoutMs } } : {}),
})

/** An adapter that, once its signal aborts, fails with `onAbort()` after `turns` microtasks. */
function abortingAdapter(onAbort: () => unknown, turns = 3): ProviderAdapter {
  return {
    id: 'google',
    run(_req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      return new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener(
          'abort',
          () => {
            void (async () => {
              for (let i = 0; i < turns; i++) await Promise.resolve()
              reject(onAbort())
            })()
          },
          { once: true },
        )
      })
    },
  } as ProviderAdapter
}

describe('usage on an adapter failure that follows a won cancellation race', () => {
  it('a deadline keeps the usage and tier of the adapter failure that follows it', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        abortingAdapter(
          () =>
            new LlmError('stopped', {
              kind: 'timeout',
              retryable: false,
              usage: ESTIMATE,
              servedServiceTier: 'priority',
            }),
        ),
      ],
      modelRegistry: REGISTRY,
      sink,
    })
    const err = await client
      .generate(request(30), { auth: AUTH })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
    expect((err as LlmError).message).toContain('timed out')
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.inputTokens).toBe(40)
    expect(sink.records[0]?.outputTokens).toBe(2_500)
  })

  it('a caller abort keeps the usage too', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        abortingAdapter(
          () =>
            new LlmError('stopped', {
              kind: 'aborted',
              retryable: false,
              usage: ESTIMATE,
            }),
        ),
      ],
      modelRegistry: REGISTRY,
      sink,
    })
    const controller = new AbortController()
    const pending = client
      .generate(request(), { auth: AUTH, signal: controller.signal })
      .catch((e: unknown) => e)
    setTimeout(() => controller.abort(), 10)
    const err = await pending
    expect((err as LlmError).kind).toBe('aborted')
    expect(sink.records[0]?.outputTokens).toBe(2_500)
  })

  it('an adapter that fails without usage, or never settles, changes nothing', async () => {
    for (const adapter of [
      abortingAdapter(() => new LlmError('plain', { kind: 'timeout', retryable: false })),
      abortingAdapter(() => new Error('raw')),
      {
        id: 'google',
        run: () => new Promise<AdapterResult>(() => {}),
      } as ProviderAdapter,
    ]) {
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        modelRegistry: REGISTRY,
        sink,
      })
      const err = await client
        .generate(request(20), { auth: AUTH })
        .catch((e: unknown) => e)
      expect((err as LlmError).kind).toBe('timeout')
      expect(sink.records[0]?.outputTokens ?? 0).toBe(0)
    }
  })
})
