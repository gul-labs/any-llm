/**
 * @gullabs/google — a Search tool held in a `cachedContent` cache.
 *
 * The request carries no search tool when the cache holds it, so nothing in
 * the request says Search was asked for. The fee is priced from what is known:
 * a handle that records the cache's tool kinds says so; a bare cache name says
 * nothing, so grounding metadata with queries is the evidence that the fee was
 * incurred. A cost is never `exact` when grounding metadata exists and the
 * request did not declare search.
 *
 * Fixtures are hand-built responses shaped like the captured
 * `grounding-usage-fields` rows (ADR-013); no network.
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
import { defaultGeminiRegistry } from './models.js'
import type { GoogleProviderOptions } from './types.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const MODEL = 'gemini-3.6-flash'
const CACHE = 'cachedContents/abc'

function request(
  cachedContent: unknown,
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  return {
    provider: 'google',
    model: MODEL,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Question?' }] }],
    config: {
      providerOptions: {
        google: cachedContent === undefined ? {} : { cachedContent },
      } as never,
    },
    modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
    ...overrides,
  }
}

const grounding = (queries?: string[]) => ({
  ...(queries !== undefined ? { webSearchQueries: queries } : {}),
  groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'A' } }],
})

function respond(groundingMetadata?: unknown) {
  return makeFakeGemini(
    fakeGeminiResponse({
      text: 'answer',
      promptTokenCount: 1000,
      candidatesTokenCount: 100,
      ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
    }),
  )
}

async function run(req: ResolvedRequest, groundingMetadata?: unknown) {
  const result = await geminiAdapter({ client: respond(groundingMetadata) }).run(
    req,
    FAKE_CTX,
  )
  const cost = geminiPricingSource().price(MODEL, result.usage, undefined)
  return { result, cost, warnings: result.warnings.map((w) => w.message).join('\n') }
}

describe('a bare cache name: grounding metadata with queries is the evidence', () => {
  it('prices the search fee from the observed queries and marks the cost estimated', async () => {
    const { result, cost, warnings } = await run(
      request(CACHE),
      grounding(['one', 'two', 'three']),
    )
    expect(result.usage.details['web_search_requested']).toBe(1)
    expect(result.usage.details['web_search_calls']).toBe(3)
    expect(cost.details.tools).toBe(42_000)
    expect(cost.confidence).toBe('estimated')
    expect(cost.microUsd).toBe(
      cost.details.input + cost.details.cached + cost.details.output + 42_000,
    )
    expect(warnings).toContain('did not declare googleSearch')
    expect(warnings).toContain('"estimated"')
  })

  it('grounding metadata with no usable query count is estimated with the tools lane empty, never exact', async () => {
    const { cost, warnings } = await run(request(CACHE), grounding(undefined))
    expect(cost.confidence).toBe('estimated')
    expect(cost.details.tools).toBe(0)
    expect(warnings).toContain('did not declare googleSearch')
  })

  it('grounding metadata that reports zero queries is still not exact', async () => {
    const { cost } = await run(request(CACHE), grounding([]))
    expect(cost.confidence).toBe('estimated')
    expect(cost.details.tools).toBe(0)
  })

  it('no grounding metadata stays token-priced, exact, with no warning', async () => {
    const { result, cost, warnings } = await run(request(CACHE))
    expect(result.usage.details).not.toHaveProperty('web_search_requested')
    expect(cost.confidence).toBe('exact')
    expect(warnings).toBe('')
  })

  it('a request with no cache and no search tool is judged the same way', async () => {
    const { cost } = await run(request(undefined), grounding(['q']))
    expect(cost.details.tools).toBe(14_000)
    expect(cost.confidence).toBe('estimated')
  })
})

describe('a handle that records its tool kinds', () => {
  it('a cache holding googleSearch marks web_search_requested and prices the queries', async () => {
    const { result, cost, warnings } = await run(
      request({ cacheName: CACHE, toolKinds: ['googleSearch'] }),
      grounding(['a', 'b']),
    )
    expect(result.usage.details['web_search_requested']).toBe(1)
    expect(result.usage.details['web_search_calls']).toBe(2)
    expect(cost.details.tools).toBe(28_000)
    expect(cost.confidence).toBe('estimated')
    expect(warnings).not.toContain('did not declare')
  })

  it('a cache holding googleSearch and a response without grounding metadata warns like a sent tool', async () => {
    const { result, cost, warnings } = await run(
      request({ cacheName: CACHE, toolKinds: ['googleSearch'] }),
    )
    expect(result.usage.details['web_search_requested']).toBe(1)
    expect(result.usage.details).not.toHaveProperty('web_search_calls')
    expect(cost.confidence).toBe('estimated')
    expect(warnings).toContain('no groundingMetadata')
  })

  it('a cache without a search tool and no grounding metadata is exact', async () => {
    const { result, cost, warnings } = await run(
      request({ cacheName: CACHE, toolKinds: ['functionDeclarations'] }),
    )
    expect(result.usage.details).not.toHaveProperty('web_search_requested')
    expect(cost.confidence).toBe('exact')
    expect(warnings).toBe('')
  })

  it('the wire request carries the cache name string only', async () => {
    const fake = respond()
    await geminiAdapter({ client: fake }).run(
      request({ cacheName: CACHE, toolKinds: ['googleSearch'] }),
      FAKE_CTX,
    )
    const config = (fake.calls[0] as { config: { cachedContent?: unknown } }).config
    expect(config.cachedContent).toBe(CACHE)
  })

  it('a billed failure from a search cache carries the search marker', async () => {
    const fake = makeFakeGemini({
      candidates: [],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    })
    const err = await geminiAdapter({ client: fake })
      .run(request({ cacheName: CACHE, toolKinds: ['googleSearch'] }), FAKE_CTX)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).usage?.details['web_search_requested']).toBe(1)
  })
})

describe('the cachedContent option shape', () => {
  it.each([
    ['an empty cacheName', { cacheName: '' }],
    ['a missing cacheName', { toolKinds: ['googleSearch'] }],
    ['toolKinds that is not an array', { cacheName: CACHE, toolKinds: 'googleSearch' }],
    ['a non-string tool kind', { cacheName: CACHE, toolKinds: [1] }],
    ['an unknown key', { cacheName: CACHE, ttl: 5 }],
    ['a number', 5],
  ])('%s is bad_request before dispatch', async (_name, value) => {
    const fake = respond()
    const err = await geminiAdapter({ client: fake })
      .run(request(value), FAKE_CTX)
      .catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).message).toContain('providerOptions.google.cachedContent')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('through the client: the model schema admits the handle shape', () => {
  function makeClient(fake: ReturnType<typeof respond>) {
    return createClient({
      adapters: [geminiAdapter({ client: fake })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink: new RecordingSink(),
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
  }
  const messages = [
    { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Question?' }] },
  ]

  it('a handle with googleSearch kinds is priced and reported estimated', async () => {
    const result = await makeClient(respond(grounding(['q1', 'q2']))).generate(
      {
        provider: 'google',
        model: MODEL,
        messages,
        config: {
          providerOptions: {
            google: { cachedContent: { cacheName: CACHE, toolKinds: ['googleSearch'] } },
          },
        },
      },
      { auth: { apiKey: 'k' } },
    )
    expect(result.cost?.details.tools).toBe(28_000)
    expect(result.cost?.confidence).toBe('estimated')
  })

  it('a bare name still validates and is priced from the evidence', async () => {
    const result = await makeClient(respond(grounding(['q1']))).generate(
      {
        provider: 'google',
        model: MODEL,
        messages,
        config: { providerOptions: { google: { cachedContent: CACHE } } },
      },
      { auth: { apiKey: 'k' } },
    )
    expect(result.cost?.details.tools).toBe(14_000)
    expect(result.cost?.confidence).toBe('estimated')
  })

  it('a whole GoogleCacheHandle is rejected (the schema is strict and the type refuses it), and a missing cacheName too', async () => {
    const run = (cachedContent: unknown) =>
      makeClient(respond()).generate(
        {
          provider: 'google',
          model: MODEL,
          messages,
          config: {
            providerOptions: { google: { cachedContent: cachedContent as never } },
          },
        },
        { auth: { apiKey: 'k' } },
      )
    await expect(
      run({ cacheName: CACHE, model: MODEL, expiresAt: new Date(0), toolKinds: [] }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(run({ toolKinds: ['googleSearch'] })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    // The type refuses it as well (checked by `pnpm typecheck`).
    const handle = {
      cacheName: CACHE,
      model: MODEL,
      expiresAt: new Date(0),
      toolKinds: ['googleSearch'] as readonly string[],
    }
    const options: GoogleProviderOptions = {
      // @ts-expect-error a whole GoogleCacheHandle is not a cachedContent reference
      cachedContent: handle,
    }
    expect(options).toBeDefined()
  })
})
