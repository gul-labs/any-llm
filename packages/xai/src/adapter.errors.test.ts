/**
 * @gullabs/xai — credits-exhausted classification (R4.13), responses that
 * report failure on a 200 (R4.14), `parallelToolCalls` without tools (R4.15),
 * and the shared transport matcher (R4.5).
 *
 * The bodies in `__fixtures__/doc-derived-error-shapes.json` are DOC-DERIVED,
 * not captures (see its `_note` and ADR-036): the account could not be driven to
 * its credit limit and no probe produced a failed response.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError, createClient, retryMiddleware } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  fakeXaiResponse,
  makeFakeXai,
  RecordingSink,
} from '@gullabs/testing'
import { classifyXaiError, xaiAdapter } from './adapter.js'
import { xaiPricingSource } from './pricing.js'
import { grok45ModelDescriptor, xaiRegistry } from './models.js'

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/doc-derived-error-shapes.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: grok45ModelDescriptor,
    ...overrides,
  }
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(LlmError)
  return err as LlmError
}

describe('R4.13 credits exhausted / spending limit (doc-derived body)', () => {
  it.each(['creditsExhausted429', 'creditsExhausted403'])(
    '%s → rate_limited, not retryable, reason credits_exhausted',
    (name) => {
      const raw = fixtures[name]!
      const err = classifyXaiError(raw)
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: false,
        reason: 'credits_exhausted',
        httpStatus: raw['status'],
        provider: 'xai',
      })
      expect(err.message).toContain('used all available credits')
      // The team id is an identifier that would land in logs and ledger rows.
      expect(err.message).not.toContain('00000000-0000-0000-0000-000000000000')
      expect(err.message).toMatch(/^Your team has either used all available credits/)
    },
  )

  it('is not retried by the retry middleware: one dispatch', async () => {
    const fake = makeFakeXai(() => {
      throw fixtures['creditsExhausted429']
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [xaiAdapter({ client: fake })],
      modelRegistry: xaiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0 },
        ),
      ],
    })
    const err = await failure(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
        },
        { auth: { apiKey: 'k' } },
      ),
    )
    expect(err).toMatchObject({ kind: 'rate_limited', reason: 'credits_exhausted' })
    expect(fake.calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
  })

  it('a plain 429 stays a retryable rate limit, and so does a 429 whose body only mentions credits', () => {
    expect(classifyXaiError({ status: 429, error: 'Too many requests' })).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    })
    const echoed = classifyXaiError({
      status: 429,
      error: 'Rate limited. Note: your credits are fine',
    })
    expect(echoed.retryable).toBe(true)
    expect(echoed.reason).toBeUndefined()
  })

  it('never reads Error.message: the sentence in free text does not change a bare 403', () => {
    const err = Object.assign(
      new Error(String(fixtures['creditsExhausted403']!['error'])),
      {
        status: 403,
      },
    )
    expect(classifyXaiError(err)).toMatchObject({ kind: 'invalid_auth' })
    expect(classifyXaiError(err).reason).toBeUndefined()
  })

  it('a bare 403 and the recorded safety-check 403 keep their classifications', () => {
    expect(classifyXaiError({ status: 403 })).toMatchObject({ kind: 'invalid_auth' })
    expect(
      classifyXaiError({
        status: 403,
        error: 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
      }),
    ).toMatchObject({ kind: 'content_filter' })
  })

  it('only a 429 or a 403 is read: the sentence on a 500 is a server error', () => {
    expect(
      classifyXaiError({ status: 500, error: fixtures['creditsExhausted429']!['error'] }),
    ).toMatchObject({ kind: 'server', retryable: true })
  })
})

describe('R4.14 a 200 that reports failure (doc-derived shapes)', () => {
  const run = async (name: string): Promise<LlmError> =>
    failure(
      xaiAdapter({ client: makeFakeXai(fixtures[name] as never) }).run(
        makeReq(),
        FAKE_CTX,
      ),
    )
  const usageOf = (name: string): { input_tokens: number; output_tokens: number } =>
    fixtures[name]!['usage'] as { input_tokens: number; output_tokens: number }

  it.each([
    // [fixture, kind, retryable, reason fragment in the message]
    ['failedResponse', 'server', true],
    ['failedRateLimit', 'rate_limited', true],
    ['failedInvalidPrompt', 'bad_request', false],
    ['failedPolicy', 'content_filter', false],
    ['failedUnknownCode', 'unknown', false],
    ['failedNoError', 'unknown', false],
    ['cancelledResponse', 'unknown', false],
  ] as const)(
    '%s → %s, retryable %s, billed usage attached',
    async (name, kind, retryable) => {
      const err = await run(name)
      expect(err).toMatchObject({ kind, retryable, provider: 'xai' })
      expect(err.usage).toMatchObject({
        inputTokens: usageOf(name).input_tokens,
        outputTokens: usageOf(name).output_tokens,
      })
    },
  )

  it('names the provider code and message for a failed response, and the status for a cancel', async () => {
    const invalid = await run('failedInvalidPrompt')
    expect(invalid.message).toContain('invalid_prompt')
    expect(invalid.message).toContain('placeholder message for invalid_prompt')
    expect((await run('cancelledResponse')).message).toContain('"cancelled"')
    expect((await run('failedUnknownCode')).message).toContain('some_future_code')
  })

  it('a completed response is a success even when it carries an error object: the billed answer is kept', async () => {
    // Not a documented shape (`error` is set only on a failed response), so
    // no fixture: the adapter must not throw a billed, usable answer away.
    const result = await xaiAdapter({
      client: makeFakeXai({
        ...fakeXaiResponse({ text: 'the answer', inputTokens: 10, outputTokens: 4 }),
        error: { code: 'server_error', message: 'stray' },
      } as never),
    }).run(makeReq(), FAKE_CTX)
    expect(result.text).toBe('the answer')
    expect(result.usage.outputTokens).toBe(4)
  })

  it('deterministic failures are not retried or re-billed: an invalid_prompt is one dispatch and one row', async () => {
    let calls = 0
    const fake = makeFakeXai(() => {
      calls += 1
      return fixtures['failedInvalidPrompt'] as never
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [xaiAdapter({ client: fake })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: xaiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0 },
        ),
      ],
    })
    const err = await failure(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
        },
        { auth: { apiKey: 'k' } },
      ),
    )
    expect(err.kind).toBe('bad_request')
    expect(calls).toBe(1)
    expect(sink.records).toHaveLength(1)
  })

  it('a failed response with no usable usage carries none', async () => {
    const err = await failure(
      xaiAdapter({
        client: makeFakeXai({
          ...fixtures['failedResponse'],
          usage: {},
        } as never),
      }).run(makeReq(), FAKE_CTX),
    )
    expect(err.kind).toBe('server')
    expect(err.usage).toBeUndefined()
  })

  it('through the engine: the failed attempt is a billed server row and is retried', async () => {
    let calls = 0
    const fake = makeFakeXai(() => {
      calls += 1
      return calls === 1
        ? (fixtures['failedResponse'] as never)
        : fakeXaiResponse({ text: 'ok', inputTokens: 10, outputTokens: 2 })
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [xaiAdapter({ client: fake })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: xaiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 2, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0 },
        ),
      ],
    })
    const result = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
      },
      { auth: { apiKey: 'k' } },
    )
    expect(result.text).toBe('ok')
    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
  })

  it('completed with no error and an incomplete (max_output_tokens) response are unchanged', async () => {
    const ok = await xaiAdapter({
      client: makeFakeXai(
        fakeXaiResponse({ text: 'hi', inputTokens: 1, outputTokens: 1 }),
      ),
    }).run(makeReq(), FAKE_CTX)
    expect(ok.finishReason).toBe('stop')
    const truncated = await xaiAdapter({
      client: makeFakeXai(
        fakeXaiResponse({
          text: 'cut',
          status: 'incomplete',
          incompleteReason: 'max_output_tokens',
        }),
      ),
    }).run(makeReq(), FAKE_CTX)
    expect(truncated.finishReason).toBe('length')
  })

  it('incomplete_details.reason content_filter is NOT mapped: no fixture shows it, so it stays other', async () => {
    const result = await xaiAdapter({
      client: makeFakeXai(
        fakeXaiResponse({
          text: '',
          status: 'incomplete',
          incompleteReason: 'content_filter',
        }),
      ),
    }).run(makeReq(), FAKE_CTX)
    expect(result.finishReason).toBe('other')
  })
})

describe('R4.15 parallelToolCalls needs a tool', () => {
  const tool = {
    name: 'get_temperature',
    description: 'Get temperature',
    inputJsonSchema: { type: 'object' as const, properties: {} },
  }

  it('rejects parallelToolCalls with no tools, before dispatch, true or false', async () => {
    for (const value of [true, false]) {
      const fake = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
      const err = await failure(
        xaiAdapter({ client: fake }).run(
          makeReq({ config: { providerOptions: { xai: { parallelToolCalls: value } } } }),
          FAKE_CTX,
        ),
      )
      expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
      expect(err.message).toContain('parallelToolCalls')
      expect(fake.calls).toHaveLength(0)
    }
  })

  it('accepts it with function tools', async () => {
    const fake = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await xaiAdapter({ client: fake }).run(
      makeReq({
        tools: [tool],
        config: { providerOptions: { xai: { parallelToolCalls: false } } },
      }),
      FAKE_CTX,
    )
    expect((fake.calls[0] as { parallel_tool_calls?: boolean }).parallel_tool_calls).toBe(
      false,
    )
  })

  it('accepts it with server tools', async () => {
    const fake = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await xaiAdapter({ client: fake }).run(
      makeReq({
        config: {
          providerOptions: {
            xai: { tools: [{ type: 'web_search' }], parallelToolCalls: true },
          },
        },
      }),
      FAKE_CTX,
    )
    expect((fake.calls[0] as { parallel_tool_calls?: boolean }).parallel_tool_calls).toBe(
      true,
    )
  })
})

describe('R4.5 shared transport matcher', () => {
  it('a fetch failed with an errno cause is a retryable server error', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const err = classifyXaiError(new TypeError('fetch failed', { cause }))
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
  })

  it('an openai SDK connection error with a custom message is still a retryable server error', () => {
    class APIConnectionError extends Error {}
    const err = classifyXaiError(new APIConnectionError('gateway went away'))
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
  })

  it('"Connection error." is recognised by core without any xAI-local matcher', () => {
    const err = classifyXaiError(new Error('Connection error.'))
    expect(err).toMatchObject({ kind: 'server', retryable: true })
  })
})
