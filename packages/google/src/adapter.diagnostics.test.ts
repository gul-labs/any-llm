/**
 * @gullabs/google — result diagnostics.
 *
 * - R1.9: reasoning that uses up `maxOutputTokens` is reported, on a normal
 *   200 (engine warning) and on a candidate-less 200 (hint in the `server` error).
 * - R1.11: a call that sent `googleSearch` never reports an exact cost.
 * - R1.10: a typed reason survives the Google error overlay.
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
import { GOOGLE_SEARCH_REQUESTED_DETAIL, geminiPricingSource } from './cost.js'
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

describe('reasoning used up the output cap (R1.9)', () => {
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
    expect(err.retryable).toBe(true)
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

describe('grounded calls are not priced as exact (R1.11)', () => {
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

  it('googleSearch sent: cost is estimated and a warning says grounding fees are missing', async () => {
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

  it('the token amount is the same either way (only the confidence changes)', async () => {
    const [grounded, plain] = await Promise.all([generate(true), generate(false)])
    expect(grounded.cost?.microUsd).toBe(plain.cost?.microUsd)
  })
})

describe('geminiPricingSource and the googleSearch flag (R1.11)', () => {
  const usage = (details: Record<string, number>) => ({
    inputTokens: 1000,
    outputTokens: 100,
    details,
    raw: null,
  })

  it('reports estimated when the adapter flagged googleSearch, with the same amount', () => {
    const source = geminiPricingSource()
    const plain = source.price(MODEL, usage({}))
    const flagged = source.price(MODEL, usage({ [GOOGLE_SEARCH_REQUESTED_DETAIL]: 1 }))
    expect(plain.confidence).toBe('exact')
    expect(flagged.confidence).toBe('estimated')
    expect(flagged.microUsd).toBe(plain.microUsd)
    expect(flagged.details).toEqual(plain.details)
  })

  it('the adapter writes the flag into usage.details only when googleSearch was sent', async () => {
    const run = async (googleSearch: boolean) => {
      const adapter = geminiAdapter({
        client: makeFakeGemini(fakeGeminiResponse({ text: 'ok' })),
      })
      return adapter.run(
        {
          provider: 'google',
          model: MODEL,
          messages,
          config: googleSearch
            ? { providerOptions: { google: { tools: [{ googleSearch: {} }] } } }
            : {},
          modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
        },
        FAKE_CTX,
      )
    }
    expect((await run(true)).usage.details[GOOGLE_SEARCH_REQUESTED_DETAIL]).toBe(1)
    expect(GOOGLE_SEARCH_REQUESTED_DETAIL in (await run(false)).usage.details).toBe(false)
  })
})

describe('typed reasons survive the Google error overlay (R1.10)', () => {
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
