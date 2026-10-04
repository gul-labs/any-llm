/**
 * @gullabs/google — failures that are billed and would repeat are not retried.
 *
 * - The adapter's own tier ceiling and the SDK's transport timer end a call that
 *   the same limit would end again, after Google may already have run (and
 *   billed) it: `timeout`, `retryable: false`, `reason: 'transport_timeout'`,
 *   as for xAI. Under `retryMiddleware` that is one billed row, not three.
 * - A candidate-less 200 that billed reasoning tokens is the cap being spent on
 *   thinking: the same request fails the same way, so it is not retried either.
 *   One that billed none keeps core's retry.
 *
 * No network: fakes from @gullabs/testing only.
 */

import { describe, expect, it } from 'vitest'
import { LlmError, createClient, retryMiddleware } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { STANDARD_DEFAULT_TIMEOUT_MS } from './client.js'
import type { GeminiClientLike, GeminiResponseShape } from './client.js'
import { geminiPricingSource } from './cost.js'
import { classifyGoogleError } from './errors.js'
import { defaultGeminiRegistry } from './models.js'

const AUTH = { apiKey: 'test-key' }
const MODEL = 'gemini-3.6-flash'
const messages = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Question?' }] },
]

function hangingClient(calls: { n: number }): GeminiClientLike {
  return {
    models: {
      generateContent(params): Promise<GeminiResponseShape> {
        calls.n += 1
        return new Promise<GeminiResponseShape>((_resolve, reject) => {
          const sig = params.config?.abortSignal
          sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
        })
      },
      countTokens() {
        return Promise.resolve({ totalTokens: 0 })
      },
    },
  }
}

describe('classifyGoogleError: a transport timeout is not retried', () => {
  it('a TimeoutError with no HTTP status is a non-retryable transport_timeout', () => {
    const err = classifyGoogleError(new DOMException('too slow', 'TimeoutError'))
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'google',
    })
  })

  it('an HTTP 408 is an answer from Google and keeps core’s retry', () => {
    expect(classifyGoogleError({ status: 408 })).toMatchObject({
      kind: 'timeout',
      retryable: true,
    })
  })

  it('an already-classified LlmError timeout is not second-guessed', () => {
    expect(
      classifyGoogleError(new LlmError('t', { kind: 'timeout', retryable: true })),
    ).toMatchObject({ retryable: true })
  })

  it('the adapter flag names what happened and wins over the raw error', () => {
    const err = classifyGoogleError(new Error('weird'), { transportTimeout: 'it hit X' })
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      message: 'it hit X',
    })
  })
})

describe('the tier ceiling under retryMiddleware', () => {
  it('a standard call that reaches the client-side ceiling is dispatched once and booked as one timeout row', async () => {
    const clock = new FakeClock()
    const calls = { n: 0 }
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [geminiAdapter({ client: hangingClient(calls) })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      middleware: [retryMiddleware({ maxAttempts: 3 })],
      sink,
      clock,
      scheduler: clock,
      ids: new FakeIds(),
    })
    const settled = client
      .generate(
        {
          provider: 'google',
          model: MODEL,
          messages,
          config: { serviceTier: 'standard' },
        },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)
    await clock.advanceAsync(STANDARD_DEFAULT_TIMEOUT_MS + 1)
    const err = (await settled) as LlmError
    await clock.advanceAsync(60_000)

    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
    expect(calls.n).toBe(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ status: 'timeout', attemptNumber: 1 })
  })

  it('the SDK transport timer (a plain AbortError nobody asked for) is the same non-retryable timeout', async () => {
    const calls = { n: 0 }
    const sink = new RecordingSink()
    const aborting: GeminiClientLike = {
      models: {
        generateContent(): Promise<GeminiResponseShape> {
          calls.n += 1
          return Promise.reject(
            new DOMException('This operation was aborted', 'AbortError'),
          )
        },
        countTokens() {
          return Promise.resolve({ totalTokens: 0 })
        },
      },
    }
    const client = createClient({
      adapters: [geminiAdapter({ client: aborting })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      middleware: [retryMiddleware({ maxAttempts: 3 }, { sleep: async () => {} })],
      sink,
      ids: new FakeIds(),
    })
    const err = (await client
      .generate(
        {
          provider: 'google',
          model: MODEL,
          messages,
          config: { serviceTier: 'standard' },
        },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
    expect(calls.n).toBe(1)
    expect(sink.records).toHaveLength(1)
  })

  it('the caller’s own abort stays an abort', async () => {
    const controller = new AbortController()
    const aborting: GeminiClientLike = {
      models: {
        generateContent(): Promise<GeminiResponseShape> {
          controller.abort()
          return Promise.reject(
            new DOMException('This operation was aborted', 'AbortError'),
          )
        },
        countTokens() {
          return Promise.resolve({ totalTokens: 0 })
        },
      },
    }
    const adapter = geminiAdapter({ client: aborting })
    const ctx: AdapterCtx = {
      auth: AUTH,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      signal: controller.signal,
    }
    const req: ResolvedRequest = {
      provider: 'google',
      model: MODEL,
      messages,
      config: { serviceTier: 'standard' },
      modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
    }
    const err = (await adapter.run(req, ctx).catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ kind: 'aborted', retryable: false })
  })
})

describe('a candidate-less 200 under retryMiddleware', () => {
  const run = async (usageMetadata: Record<string, number>) => {
    const fake = makeFakeGemini({ candidates: [], usageMetadata })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [geminiAdapter({ client: fake })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      middleware: [retryMiddleware({ maxAttempts: 3 }, { sleep: async () => {} })],
      sink,
      ids: new FakeIds(),
    })
    const err = (await client
      .generate(
        { provider: 'google', model: MODEL, messages, config: { maxOutputTokens: 100 } },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)) as LlmError
    return { err, sink, dispatches: fake.calls.length }
  }

  it('with billed reasoning tokens: one dispatch, one billed row, not retried', async () => {
    const { err, sink, dispatches } = await run({
      promptTokenCount: 20,
      thoughtsTokenCount: 113,
    })
    expect(err).toMatchObject({ kind: 'server', retryable: false })
    expect(dispatches).toBe(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.thinkingTokens).toBe(113)
  })

  it('with no reasoning evidence it is still retried', async () => {
    const { err, dispatches, sink } = await run({ promptTokenCount: 20 })
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(dispatches).toBe(3)
    expect(sink.records).toHaveLength(3)
  })
})

describe('a normal response is unaffected', () => {
  it('still succeeds', async () => {
    const client = createClient({
      adapters: [
        geminiAdapter({
          client: makeFakeGemini(fakeGeminiResponse({ text: 'ok' })),
        }),
      ],
      modelRegistry: defaultGeminiRegistry,
    })
    const result = await client.generate(
      { provider: 'google', model: MODEL, messages },
      { auth: AUTH },
    )
    expect(result.text).toBe('ok')
  })
})
