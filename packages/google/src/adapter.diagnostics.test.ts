/**
 * @gullabs/google — result diagnostics.
 *
 * - Reasoning that uses up `maxOutputTokens` is reported, on a normal
 *   200 (engine warning) and on a candidate-less 200 (hint in the `server` error).
 * - A call that sent `googleSearch` never reports an exact cost unless the
 *   response proves Search did not run; failed-but-billed attempts carry the facts.
 * - A typed reason survives the Google error overlay.
 *
 * All tests use fakes from @gullabs/testing — no network.
 */

import { describe, expect, it } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { classifyGoogleError } from './errors.js'
import { defaultGeminiRegistry } from './models.js'

const AUTH = { apiKey: 'test-key' }
const FAKE_CTX: AdapterCtx = {
  auth: AUTH,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const MODEL = 'gemini-3.6-flash'

function makeClient(fake: ReturnType<typeof makeFakeGemini>, sink = new RecordingSink()) {
  return createClient({
    adapters: [geminiAdapter({ client: fake })],
    pricingSources: { google: geminiPricingSource() },
    modelRegistry: defaultGeminiRegistry,
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
}

const messages = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Question?' }] },
]

describe('reasoning used up the output cap', () => {
  it('a MAX_TOKENS response with only reasoning tokens carries the warning', async () => {
    const client = makeClient(
      makeFakeGemini(
        fakeGeminiResponse({
          finishReason: 'MAX_TOKENS',
          promptTokenCount: 20,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 800,
        }),
      ),
    )

    const result = await client.generate(
      { provider: 'google', model: MODEL, messages, config: { maxOutputTokens: 800 } },
      { auth: AUTH },
    )

    expect(result.finishReason).toBe('length')
    expect(result.text).toBeUndefined()
    expect(result.usage.thinkingTokens).toBe(800)
    expect(result.warnings.map((w) => w.message)).toContain(
      'maxOutputTokens (800) was used up by reasoning (800 tokens); no answer was produced. Raise maxOutputTokens or lower the reasoning effort.',
    )
  })

  it('a MAX_TOKENS response that still produced text has no such warning', async () => {
    const client = makeClient(
      makeFakeGemini(
        fakeGeminiResponse({
          text: 'cut off mid-sent',
          finishReason: 'MAX_TOKENS',
          candidatesTokenCount: 10,
          thoughtsTokenCount: 790,
        }),
      ),
    )
    const result = await client.generate(
      { provider: 'google', model: MODEL, messages, config: { maxOutputTokens: 800 } },
      { auth: AUTH },
    )
    expect(result.warnings.some((w) => w.message.includes('used up by reasoning'))).toBe(
      false,
    )
  })

  it('a 200 with zero candidates but thought tokens names the cap in its server error', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini({
        candidates: [],
        usageMetadata: { promptTokenCount: 20, thoughtsTokenCount: 113 },
      }),
    })
    const req: ResolvedRequest = {
      provider: 'google',
      model: MODEL,
      messages,
      config: { maxOutputTokens: 100 },
      modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
    }

    const err = (await adapter.run(req, FAKE_CTX).catch((e: unknown) => e)) as LlmError

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('server')
    // Billed reasoning and no answer: the same request with the same cap fails
    // the same way, so it is not retried.
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('NO_CANDIDATES')
    expect(err.message).toContain('113 reasoning tokens')
    expect(err.message).toContain('maxOutputTokens (100) includes reasoning tokens')
    expect(err.usage?.thinkingTokens).toBe(113)
  })

  it('a candidate-less 200 without thought tokens keeps the plain message', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini({ candidates: [], usageMetadata: { promptTokenCount: 20 } }),
    })
    const err = (await adapter
      .run(
        {
          provider: 'google',
          model: MODEL,
          messages,
          config: {},
          modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
        },
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(err.message).toBe('Gemini response has no usable candidate: NO_CANDIDATES')
  })
})

describe('grounded calls are not priced as exact', () => {
  const generate = (googleSearch: boolean) => {
    const sink = new RecordingSink()
    const client = makeClient(
      makeFakeGemini(
        fakeGeminiResponse({
          text: 'grounded answer',
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
        }),
      ),
      sink,
    )
    return client.generate(
      {
        provider: 'google',
        model: MODEL,
        messages,
        config: googleSearch
          ? { providerOptions: { google: { tools: [{ googleSearch: {} }] } } }
          : {},
      },
      { auth: AUTH },
    )
  }

  it('googleSearch sent, no metadata: cost is estimated and a warning says grounding fees are missing', async () => {
    const result = await generate(true)
    expect(result.cost?.microUsd).toEqual(expect.any(Number))
    expect(result.cost?.confidence).toBe('estimated')
    expect(
      result.warnings.some((w) => w.message.includes('grounding fees are not included')),
    ).toBe(true)
  })

  it('no googleSearch: cost stays exact with no grounding warning', async () => {
    const result = await generate(false)
    expect(result.cost?.confidence).toBe('exact')
    expect(
      result.warnings.some((w) => w.message.includes('grounding fees are not included')),
    ).toBe(false)
  })

  it('with the search count unknown the token amount is the same either way', async () => {
    const [grounded, plain] = await Promise.all([generate(true), generate(false)])
    expect(grounded.cost?.microUsd).toBe(plain.cost?.microUsd)
    expect(grounded.cost?.details.tools).toBe(0)
  })
})

describe('grounded attempts that fail after billing carry the search facts', () => {
  const GROUNDING_WARNING = 'grounding fees are not included'
  const grounded = { providerOptions: { google: { tools: [{ googleSearch: {} }] } } }

  const failures: Array<[string, Parameters<typeof makeFakeGemini>[0], string]> = [
    [
      'a candidate-less 200',
      { candidates: [], usageMetadata: { promptTokenCount: 5000 } },
      'server',
    ],
    [
      'a prompt blocked on a 200',
      {
        candidates: [],
        promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 5000 },
      },
      'content_filter',
    ],
  ]

  it.each(failures)(
    '%s: the thrown error, the row and its cost carry the search request',
    async (_name, response, kind) => {
      const sink = new RecordingSink()
      const client = makeClient(makeFakeGemini(response), sink)
      const err = (await client
        .generate(
          { provider: 'google', model: MODEL, messages, config: grounded },
          { auth: AUTH },
        )
        .catch((e: unknown) => e)) as LlmError

      expect(err.kind).toBe(kind)
      expect(err.usage?.details['web_search_requested']).toBe(1)
      // No candidate, so no metadata: the number of searches is unknown.
      expect(err.usage?.details).not.toHaveProperty('web_search_calls')
      const row = sink.records[0]!
      expect(row.costMicroUsd).toBeGreaterThan(0)
      expect(row.tokenDetails).toMatchObject({ web_search_requested: 1 })
      expect(JSON.stringify(row.warnings)).toContain(GROUNDING_WARNING)
    },
  )

  it('an ungrounded billed failure carries neither fact nor warning', async () => {
    const sink = new RecordingSink()
    const client = makeClient(
      makeFakeGemini({ candidates: [], usageMetadata: { promptTokenCount: 5000 } }),
      sink,
    )
    await client
      .generate({ provider: 'google', model: MODEL, messages }, { auth: AUTH })
      .catch(() => undefined)
    const row = sink.records[0]!
    expect(row.costMicroUsd).toBeGreaterThan(0)
    expect(row.tokenDetails).not.toHaveProperty('web_search_requested')
    expect(row.warnings).toBeUndefined()
  })
})

describe('typed reasons survive the Google error overlay', () => {
  it('keeps reason when re-classifying an LlmError', () => {
    const original = new LlmError('window exhausted', {
      kind: 'rate_limited',
      retryable: false,
      reason: 'quota_window',
    })
    const classified = classifyGoogleError(original)
    expect(classified.kind).toBe('rate_limited')
    expect(classified.reason).toBe('quota_window')
  })

  it('leaves reason unset for a raw SDK error', () => {
    expect(classifyGoogleError({ status: 429 }).reason).toBeUndefined()
  })
})
