/**
 * @gullabs/google — option limits and what a model can honour.
 *
 * - `httpOptions.timeout` is a Node timer delay: above 2^31 - 1 ms the SDK's
 *   timer fires after 1 ms, so it is rejected; with `timeoutMs` set it may not
 *   undercut the engine's own deadline.
 * - Inline PDFs are capped whatever the casing or parameters of the media type.
 * - `cachedContent` and `allowSchemaWithSearch` are rejected where the model
 *   cannot honour them (by the schema, and by the adapter for a custom model).
 * - `providerMetadata.groundingMetadata` and `promptFeedback` are bounded.
 * - A flex fallback says so, and a retry never gives an untiered call a tier.
 * - The SDK and the REST `countTokens` use one pinned endpoint.
 *
 * No network: fakes, and a stubbed `fetch` under the real SDK.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { MAX_TIMER_MS } from './client.js'
import { geminiPricingSource } from './cost.js'
import { GEMINI_PRICING } from './pricing.js'
import { defaultGeminiRegistry } from './models.js'
import { Gemini25ProConfigSchema } from './model-config/gemini-2.5-pro.js'
import { Gemini36FlashConfigSchema } from './model-config/gemini-3.6-flash.js'
import { Gemma431bItConfigSchema } from './model-config/gemma-4-31b-it.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeReq(
  config: ResolvedRequest['config'] = {},
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  const model = overrides.model ?? 'gemini-2.5-flash'
  return {
    provider: 'google',
    model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config,
    modelDescriptor: defaultGeminiRegistry.resolve('google', model)!,
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

const httpOptions = (timeout: number) =>
  ({
    providerOptions: { google: { httpOptions: { timeout } } },
  }) as ResolvedRequest['config']

describe('httpOptions.timeout', () => {
  it('above 2^31 - 1 ms is bad_request before dispatch (a timer that size fires after 1 ms)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(makeReq(httpOptions(3_000_000_000)), FAKE_CTX),
    )
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect(err.message).toContain('2147483647')
    expect(client.calls).toHaveLength(0)
  })

  it('2^31 - 1 itself is accepted and sent unchanged', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await geminiAdapter({ client }).run(makeReq(httpOptions(MAX_TIMER_MS)), FAKE_CTX)
    const call = client.calls[0] as { config: { httpOptions?: { timeout?: number } } }
    expect(call.config.httpOptions?.timeout).toBe(MAX_TIMER_MS)
  })

  it('below timeoutMs + 5000 is bad_request: the SDK would abort before the engine does', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(
        makeReq({ timeoutMs: 60_000, ...httpOptions(60_000) }),
        FAKE_CTX,
      ),
    )
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('65000')
    expect(client.calls).toHaveLength(0)
  })

  it('exactly timeoutMs + 5000 is accepted', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await geminiAdapter({ client }).run(
      makeReq({ timeoutMs: 60_000, ...httpOptions(65_000) }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { config: { httpOptions?: { timeout?: number } } }
    expect(call.config.httpOptions?.timeout).toBe(65_000)
  })

  it('with no timeoutMs a short transport timeout is the caller choice and is sent', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await geminiAdapter({ client }).run(makeReq(httpOptions(1_000)), FAKE_CTX)
    const call = client.calls[0] as { config: { httpOptions?: { timeout?: number } } }
    expect(call.config.httpOptions?.timeout).toBe(1_000)
  })

  it.each([
    ['gemini-2.5-pro', Gemini25ProConfigSchema],
    ['gemini-3.6-flash', Gemini36FlashConfigSchema],
    ['gemma-4-31b-it', Gemma431bItConfigSchema],
  ])(
    '%s schema rejects a transport timeout above the timer maximum',
    (_model, schema) => {
      const parse = (timeout: number) =>
        schema.safeParse({ providerOptions: { google: { httpOptions: { timeout } } } })
      expect(parse(MAX_TIMER_MS).success).toBe(true)
      expect(parse(MAX_TIMER_MS + 1).success).toBe(false)
    },
  )
})

describe('inline PDF cap', () => {
  const MIB = 1024 * 1024
  const base64Of = (bytes: number): string => 'A'.repeat(Math.ceil((bytes * 4) / 3))

  it.each(['application/pdf', 'Application/PDF', 'application/pdf; charset=binary'])(
    'a 51 MiB inline %s is over the 50 MB PDF limit',
    async (mimeType) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      const err = await failure(
        geminiAdapter({ client }).run(
          makeReq(
            {},
            {
              messages: [
                {
                  role: 'user',
                  parts: [{ kind: 'inline-media', mimeType, data: base64Of(51 * MIB) }],
                },
              ],
            },
          ),
          FAKE_CTX,
        ),
      )
      expect(err.issues?.[0]?.message).toBe('inline PDF over 50 MB')
      expect(client.calls).toHaveLength(0)
    },
  )
})

describe('options a model cannot honour', () => {
  it('Gemma has no explicit caching: cachedContent is bad_request in the adapter and the schema', async () => {
    const descriptor = defaultGeminiRegistry.resolve('google', 'gemma-4-31b-it')!
    expect(descriptor.capabilities?.caching).toBeUndefined()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(
        makeReq(
          { providerOptions: { google: { cachedContent: 'cachedContents/x' } } } as never,
          { model: 'gemma-4-31b-it' },
        ),
        FAKE_CTX,
      ),
    )
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('cachedContent')
    expect(client.calls).toHaveLength(0)
    expect(
      Gemma431bItConfigSchema.safeParse({
        providerOptions: { google: { cachedContent: 'cachedContents/x' } },
      }).success,
    ).toBe(false)
  })

  it('allowSchemaWithSearch is not in the Gemini 2.5 or Gemma schemas, which the adapter always rejects it for', () => {
    const parse = (
      schema: typeof Gemini25ProConfigSchema | typeof Gemma431bItConfigSchema,
    ) =>
      schema.safeParse({
        providerOptions: { google: { allowSchemaWithSearch: true } },
      }).success
    expect(parse(Gemini25ProConfigSchema)).toBe(false)
    expect(parse(Gemma431bItConfigSchema)).toBe(false)
    expect(
      Gemini36FlashConfigSchema.safeParse({
        providerOptions: { google: { allowSchemaWithSearch: true } },
      }).success,
    ).toBe(true)
  })
})

describe('bounded provider metadata', () => {
  it('groundingMetadata and promptFeedback are bounded like the candidate fields, with a warning', async () => {
    const long = 'x'.repeat(5_000)
    const supports = Array.from({ length: 80 }, () => ({
      segment: { startIndex: 0, endIndex: 1, text: long },
      groundingChunkIndices: [0],
    }))
    const client = makeFakeGemini({
      candidates: [
        {
          content: { parts: [{ text: 'answer' }] },
          finishReason: 'STOP',
          groundingMetadata: {
            webSearchQueries: ['q'],
            groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'A' } }],
            groundingSupports: supports,
          },
        },
      ],
      promptFeedback: {
        safetyRatings: Array.from({ length: 80 }, () => ({ category: long })),
      },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    })
    const result = await geminiAdapter({ client }).run(
      makeReq(
        { providerOptions: { google: { tools: [{ googleSearch: {} }] } } } as never,
        {
          model: 'gemini-3.6-flash',
        },
      ),
      FAKE_CTX,
    )
    const meta = result.providerMetadata as {
      groundingMetadata: { groundingSupports: Array<{ segment: { text: string } }> }
      promptFeedback: { safetyRatings: Array<{ category: string }> }
    }
    expect(meta.groundingMetadata.groundingSupports).toHaveLength(50)
    expect(
      meta.groundingMetadata.groundingSupports[0]!.segment.text.length,
    ).toBeLessThanOrEqual(2049)
    expect(meta.promptFeedback.safetyRatings).toHaveLength(50)
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      'providerMetadata was truncated',
    )
  })

  it('a small grounded response is copied whole and raises no truncation warning', async () => {
    const metadata = {
      webSearchQueries: ['q'],
      groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'A' } }],
    }
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'answer', groundingMetadata: metadata }),
    )
    const result = await geminiAdapter({ client }).run(
      makeReq(
        { providerOptions: { google: { tools: [{ googleSearch: {} }] } } } as never,
        {
          model: 'gemini-3.6-flash',
        },
      ),
      FAKE_CTX,
    )
    expect(
      (result.providerMetadata as { groundingMetadata: unknown }).groundingMetadata,
    ).toEqual(metadata)
    expect(result.warnings.map((w) => w.message).join('\n')).not.toContain('truncated')
  })
})

describe('flex fallback and the retry pin', () => {
  const messages = [
    { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
  ]

  function makeClient(
    fake: ReturnType<typeof makeFakeGemini>,
    sink = new RecordingSink(),
  ) {
    return {
      sink,
      client: createClient({
        adapters: [geminiAdapter({ client: fake })],
        pricingSources: { google: geminiPricingSource() },
        modelRegistry: defaultGeminiRegistry,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
        middleware: [
          retryMiddleware(
            { maxAttempts: 2, baseDelayMs: 0 },
            { sleep: async () => {}, random: () => 0 },
          ),
        ],
      }),
    }
  }

  it('a flex call sent again at standard says so, and names the ceiling when no timeoutMs is set', async () => {
    let call = 0
    const fake = makeFakeGemini(() => {
      call += 1
      if (call === 1) throw { status: 503, message: 'no capacity' }
      return fakeGeminiResponse({ text: 'ok' })
    })
    const result = await geminiAdapter({ client: fake }).run(
      makeReq({ serviceTier: 'flex' }, { model: 'gemini-2.5-pro' }),
      FAKE_CTX,
    )
    const warning = result.warnings.map((w) => w.message).join('\n')
    expect(warning).toContain('sent again at the standard tier')
    expect(warning).toContain('300000 ms client-side ceiling')
  })

  it('with timeoutMs set the fallback warning names no ceiling', async () => {
    let call = 0
    const fake = makeFakeGemini(() => {
      call += 1
      if (call === 1) throw { status: 503, message: 'no capacity' }
      return fakeGeminiResponse({ text: 'ok' })
    })
    const result = await geminiAdapter({ client: fake }).run(
      makeReq({ serviceTier: 'flex', timeoutMs: 120_000 }, { model: 'gemini-2.5-pro' }),
      FAKE_CTX,
    )
    const warning = result.warnings.map((w) => w.message).join('\n')
    expect(warning).toContain('sent again at the standard tier')
    expect(warning).not.toContain('ceiling')
  })

  it('an untiered call whose first attempt is billed is retried exactly as sent: no serviceTier, no ceiling, no transport timeout', async () => {
    const shapes: Array<{
      serviceTier: unknown
      httpOptions: unknown
      hasSignal: boolean
    }> = []
    let call = 0
    const fake = makeFakeGemini((params) => {
      call += 1
      const config = (params as { config: Record<string, unknown> }).config
      shapes.push({
        serviceTier: config['serviceTier'],
        httpOptions: config['httpOptions'],
        hasSignal: config['abortSignal'] !== undefined,
      })
      if (call === 1) {
        return {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 10,
            thoughtsTokenCount: 0,
            serviceTier: 'standard',
          },
        }
      }
      return fakeGeminiResponse({ text: 'ok' })
    })
    const { client, sink } = makeClient(fake)
    const result = await client.generate(
      { provider: 'google', model: 'gemini-2.5-flash', messages },
      { auth: { apiKey: 'k' } },
    )
    expect(result.text).toBe('ok')
    expect(shapes).toHaveLength(2)
    expect(shapes[1]).toEqual(shapes[0])
    expect(shapes[1]).toEqual({
      serviceTier: undefined,
      httpOptions: undefined,
      hasSignal: false,
    })
    expect(sink.records[0]?.servedServiceTier).toBe('standard')
    expect(sink.records[0]?.serviceTier ?? null).toBeNull()
  })

  it('a failed flex attempt keeps the requested tier on its row', async () => {
    const fake = makeFakeGemini(() => {
      throw { status: 500, message: 'boom' }
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [geminiAdapter({ client: fake })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages,
          config: { serviceTier: 'flex' },
        },
        { auth: { apiKey: 'k' } },
      )
      .catch(() => undefined)
    expect(sink.records[0]).toMatchObject({ status: 'api_error', serviceTier: 'flex' })
  })
})

describe('GEMINI_PRICING is deep-frozen', () => {
  it('no rate, long-context band or audio rate can be changed', () => {
    const pro = GEMINI_PRICING['gemini-2.5-pro']!
    const flash = GEMINI_PRICING['gemini-2.5-flash']!
    expect(Object.isFrozen(pro)).toBe(true)
    expect(Object.isFrozen(pro.standard)).toBe(true)
    expect(Object.isFrozen(pro.flex)).toBe(true)
    expect(Object.isFrozen(pro.standard.gt200k)).toBe(true)
    expect(Object.isFrozen(flash.standard.audio)).toBe(true)
    expect(() => {
      pro.standard.inputPerM = 1
    }).toThrow(TypeError)
    expect(() => {
      flash.flex.audio!.inputPerM = 1
    }).toThrow(TypeError)
    for (const entry of Object.values(GEMINI_PRICING)) {
      for (const rates of [entry.standard, entry.flex]) {
        expect(Object.isFrozen(rates)).toBe(true)
        if (rates.gt200k !== undefined) expect(Object.isFrozen(rates.gt200k)).toBe(true)
        if (rates.audio !== undefined) expect(Object.isFrozen(rates.audio)).toBe(true)
      }
    }
  })
})

describe('one pinned endpoint for the SDK and the REST countTokens (real SDK, stubbed fetch)', () => {
  let urls: string[]
  beforeEach(() => {
    urls = []
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://proxy.invalid')
    vi.stubGlobal('fetch', (url: unknown) => {
      urls.push(String(url))
      const body = String(url).includes(':countTokens')
        ? { totalTokens: 3 }
        : {
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('generate and countTokens (messages only, and with system) all go to the Developer API, never to a base URL taken from the environment', async () => {
    const adapter = geminiAdapter()
    await adapter.run(makeReq(), FAKE_CTX)
    await adapter.countTokens!(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
      },
      FAKE_CTX,
    )
    await adapter.countTokens!(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        system: 'Be brief.',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
      },
      FAKE_CTX,
    )
    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens',
    ])
  })
})
