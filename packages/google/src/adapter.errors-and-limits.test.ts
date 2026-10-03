/**
 * @gullabs/google — output-side filter stops, cachedContent conflicts,
 * safetySettings enumeration, inline payload limits and `countTokens` with
 * `system` / `tools` (ADR-036, adapter rows of R4).
 *
 * Unit tests use the fakes from @gullabs/testing. The `countTokens` wire tests
 * run the real `@google/genai` client with only `fetch` stubbed, so a throw
 * inside the SDK's own request transformers is caught (the original R1.8 gap).
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LlmError,
  composeProviders,
  createClient,
  createModelRegistry,
} from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest, TokenCountRequest } from '@gullabs/core'
import { fakeGeminiResponse, makeFakeGemini, RecordingSink } from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry, geminiModelDescriptors } from './models.js'
import { googleProvider } from './provider.js'
import { GOOGLE_SAFETY_CATEGORIES, GOOGLE_SAFETY_THRESHOLDS } from './safety-settings.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-flash')!,
    ...overrides,
  }
}

const TOOL = {
  name: 'get_temperature',
  description: 'Get temperature',
  inputJsonSchema: { type: 'object' as const, properties: { city: { type: 'string' } } },
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(LlmError)
  return err as LlmError
}

// ---------------------------------------------------------------------------
// R4.11 output-side filter stops
// ---------------------------------------------------------------------------

describe('R4.11 output-side filter stop', () => {
  const FILTER_REASONS = [
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
  ]

  it.each(FILTER_REASONS)(
    '%s with no text and no tool call throws content_filter, not retryable, usage attached',
    async (finishReason) => {
      const client = makeFakeGemini(
        fakeGeminiResponse({
          finishReason,
          promptTokenCount: 120,
          candidatesTokenCount: 3,
        }),
      )
      const err = await failure(geminiAdapter({ client }).run(makeReq(), FAKE_CTX))
      expect(err).toMatchObject({
        kind: 'content_filter',
        retryable: false,
        provider: 'google',
      })
      expect(err.message).toContain(finishReason)
      expect(err.usage).toMatchObject({ inputTokens: 120, outputTokens: 3 })
    },
  )

  it('names the finishMessage when Google sends one', async () => {
    const client = makeFakeGemini({
      candidates: [
        {
          content: { parts: [] },
          finishReason: 'SPII',
          finishMessage: 'Sensitive personal information detected',
        },
      ],
      usageMetadata: { promptTokenCount: 5 },
    })
    const err = await failure(geminiAdapter({ client }).run(makeReq(), FAKE_CTX))
    expect(err.message).toContain('Sensitive personal information detected')
  })

  it('thought-only output is no answer: it still throws', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        thoughtText: 'thinking about it',
        finishReason: 'SAFETY',
        promptTokenCount: 10,
      }),
    )
    const err = await failure(geminiAdapter({ client }).run(makeReq(), FAKE_CTX))
    expect(err.kind).toBe('content_filter')
  })

  it('partial answer text is a success that carries finishReason content_filter', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'The answer begins', finishReason: 'SAFETY' }),
    )
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.text).toBe('The answer begins')
    expect(result.finishReason).toBe('content_filter')
  })

  it('a tool call is an answer: a filter stop after it is a success with the call', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'SAFETY',
        parts: [{ functionCall: { name: 'get_temperature', args: { city: 'Rome' } } }],
      }),
    )
    const result = await geminiAdapter({ client }).run(
      makeReq({ tools: [TOOL] }),
      FAKE_CTX,
    )
    expect(result.toolCalls).toHaveLength(1)
  })

  it('a non-filter stop with no text (MAX_TOKENS) is not turned into an error', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ finishReason: 'MAX_TOKENS' }))
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.finishReason).toBe('length')
  })

  it('judged before requireGrounding: a grounded but filtered empty candidate is content_filter, not a success', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'SAFETY',
        promptTokenCount: 10,
        groundingMetadata: { webSearchQueries: ['q'] },
      }),
    )
    const err = await failure(
      geminiAdapter({ client }).run(
        makeReq({
          modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-flash')!,
          config: {
            providerOptions: {
              google: { tools: [{ googleSearch: {} }], requireGrounding: true },
            },
          },
        }),
        FAKE_CTX,
      ),
    )
    expect(err).toMatchObject({ kind: 'content_filter', retryable: false })
  })

  it('through the engine: one attempt, a content_filter row that carries the billed usage', async () => {
    const sink = new RecordingSink()
    const fake = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'IMAGE_PROHIBITED_CONTENT',
        promptTokenCount: 1000,
        candidatesTokenCount: 10,
      }),
    )
    const client = createClient({
      adapters: [geminiAdapter({ client: fake })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: createModelRegistry(geminiModelDescriptors),
      sink,
    })
    const err = await failure(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
        },
        { auth: { apiKey: 'k' } },
      ),
    )
    expect(err.kind).toBe('content_filter')
    expect(fake.calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.status).toBe('content_filter')
    expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
  })
})

describe('R4.11 providerMetadata.google.candidate', () => {
  it('copies the raw finish reason, message, safety ratings, citation and URL-context metadata', async () => {
    const safetyRatings = [
      { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
    ]
    const citationMetadata = { citations: [{ uri: 'https://example.com' }] }
    const urlContextMetadata = { urlMetadata: [{ retrievedUrl: 'https://example.com' }] }
    const client = makeFakeGemini({
      candidates: [
        {
          content: { parts: [{ text: 'partial' }] },
          finishReason: 'MALFORMED_FUNCTION_CALL',
          finishMessage: 'bad call',
          safetyRatings,
          citationMetadata,
          urlContextMetadata,
        },
      ],
      usageMetadata: { promptTokenCount: 1 },
    })
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    // The mapped finish reason collapses to 'other'; the raw one survives.
    expect(result.finishReason).toBe('other')
    expect(result.providerMetadata).toMatchObject({
      google: {
        candidate: {
          finishReason: 'MALFORMED_FUNCTION_CALL',
          finishMessage: 'bad call',
          safetyRatings,
          citationMetadata,
          urlContextMetadata,
        },
      },
    })
  })

  it('merges with searchEntryPoint under one google key', async () => {
    const entry = { renderedContent: '<div>Search</div>' }
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'grounded',
        finishReason: 'STOP',
        groundingMetadata: { webSearchQueries: ['q'], searchEntryPoint: entry },
      }),
    )
    const result = await geminiAdapter({ client }).run(
      makeReq({
        config: {
          providerOptions: { google: { tools: [{ googleSearch: {} }] } },
        },
      }),
      FAKE_CTX,
    )
    expect(result.providerMetadata).toMatchObject({
      google: { searchEntryPoint: entry, candidate: { finishReason: 'STOP' } },
    })
  })

  it('omits only absent fields: a candidate with no raw fields adds no candidate key', async () => {
    const client = makeFakeGemini({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1 },
    })
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.providerMetadata).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// R4.17 cachedContent conflicts
// ---------------------------------------------------------------------------

describe('R4.17 cachedContent with system or tools', () => {
  const cached = {
    providerOptions: { google: { cachedContent: 'cachedContents/abc' } },
  }

  it('cachedContent alone dispatches', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await geminiAdapter({ client }).run(makeReq({ config: cached }), FAKE_CTX)
    expect(client.calls).toHaveLength(1)
  })

  it.each([
    ['system', { system: 'Be brief.' }, ['system']],
    ['tools', { tools: [TOOL] }, ['tools']],
    ['system and tools', { system: 'Be brief.', tools: [TOOL] }, ['system', 'tools']],
  ])('%s → bad_request naming the field before dispatch', async (_n, extra, paths) => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(makeReq({ config: cached, ...extra }), FAKE_CTX),
    )
    expect(err).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      provider: 'google',
    })
    expect(err.issues?.map((i) => i.path)).toEqual(paths)
    expect(err.message).toContain('GoogleCacheStore.create')
    expect(client.calls).toHaveLength(0)
  })

  it('cachedContent with providerOptions.google.tools (googleSearch) is rejected too', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(
        makeReq({
          config: {
            providerOptions: {
              google: {
                cachedContent: 'cachedContents/abc',
                tools: [{ googleSearch: {} }],
              },
            },
          },
        }),
        FAKE_CTX,
      ),
    )
    expect(err.issues?.map((i) => i.path)).toEqual(['providerOptions.google.tools'])
    expect(client.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// R4.18 safetySettings enumeration
// ---------------------------------------------------------------------------

describe('R4.18 safetySettings categories and thresholds', () => {
  const run = (safetySettings: unknown) =>
    geminiAdapter({ client: makeFakeGemini(fakeGeminiResponse({ text: 'ok' })) }).run(
      makeReq({
        config: { providerOptions: { google: { safetySettings } } } as never,
      }),
      FAKE_CTX,
    )

  it.each([...GOOGLE_SAFETY_CATEGORIES])(
    'accepts the documented category %s',
    async (category) => {
      await expect(
        run([{ category, threshold: 'BLOCK_ONLY_HIGH' }]),
      ).resolves.toBeDefined()
    },
  )

  it.each([...GOOGLE_SAFETY_THRESHOLDS])(
    'accepts the documented threshold %s',
    async (threshold) => {
      await expect(
        run([{ category: 'HARM_CATEGORY_HARASSMENT', threshold }]),
      ).resolves.toBeDefined()
    },
  )

  it('lists the documented set and rejects a typo or case change before dispatch', async () => {
    expect([...GOOGLE_SAFETY_CATEGORIES]).toEqual([
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
      'HARM_CATEGORY_JAILBREAK',
    ])
    expect([...GOOGLE_SAFETY_THRESHOLDS]).toEqual([
      'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      'BLOCK_LOW_AND_ABOVE',
      'BLOCK_MEDIUM_AND_ABOVE',
      'BLOCK_ONLY_HIGH',
      'BLOCK_NONE',
      'OFF',
    ])
    const typoCategory = await failure(
      run([{ category: 'HARM_CATEGORY_HARASMENT', threshold: 'OFF' }]),
    )
    expect(typoCategory).toMatchObject({ kind: 'bad_request', retryable: false })
    expect(typoCategory.message).toContain('safetySettings[0].category')
    expect(typoCategory.message).toContain('HARM_CATEGORY_HARASSMENT')
    const badThreshold = await failure(
      run([
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'block_none' },
      ]),
    )
    expect(badThreshold.message).toContain('safetySettings[1].threshold')
  })

  it('the SDK-only image categories are not admitted', async () => {
    const err = await failure(
      run([{ category: 'HARM_CATEGORY_IMAGE_HATE', threshold: 'OFF' }]),
    )
    expect(err.kind).toBe('bad_request')
  })

  it('every model config schema enforces the same lists', () => {
    for (const descriptor of geminiModelDescriptors) {
      const text = JSON.stringify(descriptor.configJsonSchema)
      for (const category of GOOGLE_SAFETY_CATEGORIES) expect(text).toContain(category)
      for (const threshold of GOOGLE_SAFETY_THRESHOLDS) expect(text).toContain(threshold)
    }
  })
})

// ---------------------------------------------------------------------------
// R4.20 inline payload size
// ---------------------------------------------------------------------------

describe('R4.20 inline payload size check', () => {
  const MIB = 1024 * 1024
  /** Base64 text of `bytes` decoded bytes, without allocating real data twice. */
  const base64Of = (bytes: number): string => 'A'.repeat(Math.ceil((bytes * 4) / 3))

  it('an inline PDF over 50 MB is rejected before dispatch, naming the part', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = await failure(
      geminiAdapter({ client }).run(
        makeReq({
          messages: [
            {
              role: 'user',
              parts: [
                { kind: 'text', text: 'Summarise' },
                {
                  kind: 'inline-media',
                  mimeType: 'application/pdf',
                  data: base64Of(51 * MIB),
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    )
    expect(err).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      provider: 'google',
    })
    expect(err.issues?.[0]?.path).toBe('messages[0].parts[1]')
    expect(err.message).toContain('GoogleFileStore')
    expect(client.calls).toHaveLength(0)
  })

  it('a request over 100 MB in total is rejected, a 49 MB PDF is not', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const image = (bytes: number) => ({
      kind: 'inline-media' as const,
      mimeType: 'image/png',
      data: base64Of(bytes),
    })
    const err = await failure(
      adapter.run(
        makeReq({
          messages: [
            { role: 'user', parts: [image(40 * MIB), image(40 * MIB), image(40 * MIB)] },
          ],
        }),
        FAKE_CTX,
      ),
    )
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect(err.issues?.[0]?.path).toBe('messages')
    expect(client.calls).toHaveLength(0)

    await adapter.run(
      makeReq({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'inline-media',
                mimeType: 'application/pdf',
                data: base64Of(49 * MIB),
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    expect(client.calls).toHaveLength(1)
  })

  it('countTokens applies the same limit', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 1 })
    const err = await failure(
      geminiAdapter({ client }).countTokens!(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'inline-media',
                  mimeType: 'application/pdf',
                  data: base64Of(51 * MIB),
                },
              ],
            },
          ],
        },
        FAKE_CTX,
      ),
    )
    expect(err.kind).toBe('bad_request')
    expect(client.countTokensCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// R4.16 countTokens with system and tools (fake client)
// ---------------------------------------------------------------------------

function makeCountReq(overrides: Partial<TokenCountRequest> = {}): TokenCountRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    ...overrides,
  }
}

describe('R4.16 countTokens carries system and tools', () => {
  it('hands the client the same systemInstruction and function declarations generate() sends', async () => {
    const countClient = makeFakeGemini({ candidates: [] }, { totalTokens: 77 })
    const runClient = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const system = 'Be brief.'
    const result = await geminiAdapter({ client: countClient }).countTokens!(
      makeCountReq({ model: 'gemini-2.5-flash', system, tools: [TOOL] }),
      FAKE_CTX,
    )
    expect(result).toMatchObject({ totalTokens: 77, accuracy: 'exact' })

    await geminiAdapter({ client: runClient }).run(
      makeReq({ system, tools: [TOOL] }),
      FAKE_CTX,
    )
    const counted = countClient.countTokensCalls[0] as {
      systemInstruction: unknown
      tools: unknown
    }
    const sent = runClient.calls[0] as {
      config: { systemInstruction: unknown; tools: unknown }
    }
    expect(counted.systemInstruction).toEqual(sent.config.systemInstruction)
    expect(counted.tools).toEqual(sent.config.tools)
  })

  it('an empty system string and an empty tools array are absent', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 9 })
    await geminiAdapter({ client }).countTokens!(
      makeCountReq({ system: '', tools: [] }),
      FAKE_CTX,
    )
    const call = client.countTokensCalls[0] as Record<string, unknown>
    expect(call).not.toHaveProperty('systemInstruction')
    expect(call).not.toHaveProperty('tools')
  })

  it('rejects a tool schema outside the Google profile before dispatch, naming the path', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 9 })
    const err = await failure(
      geminiAdapter({ client }).countTokens!(
        makeCountReq({
          tools: [{ ...TOOL, inputJsonSchema: { type: 'object', allOf: [] } }],
        }),
        FAKE_CTX,
      ),
    )
    expect(err.kind).toBe('bad_request')
    expect(JSON.stringify(err.issues ?? err.message)).toContain(
      'tools[0].inputJsonSchema',
    )
    expect(client.countTokensCalls).toHaveLength(0)
  })

  it('keeps the estimated accuracy rule for function-call history on a Gemini 3 model', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 50 })
    const result = await geminiAdapter({ client }).countTokens!(
      makeCountReq({
        model: 'gemini-3.1-pro-preview',
        system: 'Be brief.',
        tools: [TOOL],
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Weather?' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'call_1',
                toolName: 'get_temperature',
                args: { city: 'Rome' },
              },
            ],
          },
        ],
      }),
      {
        ...FAKE_CTX,
        modelDescriptor: defaultGeminiRegistry.resolve(
          'google',
          'gemini-3.1-pro-preview',
        )!,
      },
    )
    expect(result.accuracy).toBe('estimated')
  })
})

// ---------------------------------------------------------------------------
// R4.16 wire tests: the real SDK, only fetch stubbed
// ---------------------------------------------------------------------------

describe('R4.16 countTokens on the wire (real @google/genai, stubbed fetch)', () => {
  interface Sent {
    url: string
    headers: Record<string, string>
    body: Record<string, unknown>
    signal: AbortSignal | undefined
  }
  let sent: Sent[]
  let responses: Array<{ status: number; body: unknown }>

  beforeEach(() => {
    sent = []
    responses = []
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
      sent.push({
        url: String(url),
        headers,
        body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
        signal: init.signal ?? undefined,
      })
      const next = responses.shift()
      if (next === undefined) throw new Error('wire stub: no response queued')
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const adapter = geminiAdapter()
  const ctx: AdapterCtx = { ...FAKE_CTX, auth: { apiKey: 'wire-key' } }

  it('messages only: the SDK transformer builds a plain countTokens body and does not throw', async () => {
    responses.push({ status: 200, body: { totalTokens: 11 } })
    const result = await adapter.countTokens!(makeCountReq(), ctx)
    expect(result.totalTokens).toBe(11)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toMatch(/\/models\/gemini-2\.5-pro:countTokens$/)
    expect(sent[0]!.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    })
  })

  it('system and tools: one REST countTokens with a full generateContentRequest and no top-level contents', async () => {
    responses.push({
      status: 200,
      body: {
        totalTokens: 123,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 123 }],
      },
    })
    const result = await adapter.countTokens!(
      makeCountReq({ system: 'Be brief.', tools: [TOOL] }),
      ctx,
    )
    expect(result).toMatchObject({ totalTokens: 123, accuracy: 'exact' })
    expect(result.raw).toMatchObject({ totalTokens: 123 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:countTokens',
    )
    expect(sent[0]!.headers['x-goog-api-key']).toBe('wire-key')
    expect(sent[0]!.headers['content-type']).toBe('application/json')
    expect(sent[0]!.body).toEqual({
      generateContentRequest: {
        model: 'models/gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_temperature',
                description: 'Get temperature',
                parametersJsonSchema: TOOL.inputJsonSchema,
              },
            ],
          },
        ],
      },
    })
  })

  it('the system-only and tools-only forms each go through the generateContentRequest', async () => {
    responses.push({ status: 200, body: { totalTokens: 1 } })
    responses.push({ status: 200, body: { totalTokens: 2 } })
    await adapter.countTokens!(makeCountReq({ system: 'Only system.' }), ctx)
    await adapter.countTokens!(makeCountReq({ tools: [TOOL] }), ctx)
    const first = sent[0]!.body['generateContentRequest'] as Record<string, unknown>
    const second = sent[1]!.body['generateContentRequest'] as Record<string, unknown>
    expect(first).toHaveProperty('systemInstruction')
    expect(first).not.toHaveProperty('tools')
    expect(second).toHaveProperty('tools')
    expect(second).not.toHaveProperty('systemInstruction')
  })

  it('forwards the abort signal to the request', async () => {
    responses.push({ status: 200, body: { totalTokens: 1 } })
    const controller = new AbortController()
    await adapter.countTokens!(makeCountReq({ system: 'x' }), {
      ...ctx,
      signal: controller.signal,
    })
    expect(sent[0]!.signal).toBe(controller.signal)
  })

  it('a 429 from the REST form is classified like a generateContent one (RetryInfo, daily quota)', async () => {
    responses.push({
      status: 429,
      body: {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'quota',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
          ],
        },
      },
    })
    const err = await failure(adapter.countTokens!(makeCountReq({ system: 'x' }), ctx))
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
      provider: 'google',
    })
  })

  it('a bad key on the REST form is invalid_auth', async () => {
    responses.push({
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
              domain: 'googleapis.com',
            },
          ],
        },
      },
    })
    const err = await failure(adapter.countTokens!(makeCountReq({ tools: [TOOL] }), ctx))
    expect(err).toMatchObject({ kind: 'invalid_auth', retryable: false })
  })

  it('a non-JSON error body still becomes a classified error', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('upstream exploded', { status: 502, statusText: 'Bad Gateway' }),
    )
    const err = await failure(adapter.countTokens!(makeCountReq({ system: 'x' }), ctx))
    expect(err).toMatchObject({ kind: 'server', retryable: true, httpStatus: 502 })
  })

  it('works end to end through createClient', async () => {
    responses.push({ status: 200, body: { totalTokens: 31 } })
    const client = createClient({ ...composeProviders([googleProvider()]) })
    const result = await client.countTokens(
      makeCountReq({ system: 'Be brief.', tools: [TOOL] }),
      { auth: { apiKey: 'wire-key' } },
    )
    expect(result.totalTokens).toBe(31)
  })
})
