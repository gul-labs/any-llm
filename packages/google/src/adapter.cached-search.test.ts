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

describe('a schema call and Search held by a cache', () => {
  const SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  }
  const HANDLE = { cacheName: CACHE, toolKinds: ['googleSearch'] }
  const withOptions = (
    google: Record<string, unknown>,
    overrides: Partial<ResolvedRequest> = {},
  ): ResolvedRequest => ({
    ...request(undefined),
    config: { providerOptions: { google } as never },
    outputJsonSchema: SCHEMA,
    ...overrides,
  })
  const structured = (groundingMetadata?: unknown) =>
    makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: '{"answer":"x"}',
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
      }),
    )
  const runStructured = (
    fake: ReturnType<typeof structured>,
    req: ResolvedRequest,
  ): Promise<unknown> =>
    geminiAdapter({ client: fake })
      .run(req, FAKE_CTX)
      .catch((e: unknown) => e)

  it('a handle that holds googleSearch needs allowSchemaWithSearch, exactly like an inline googleSearch', async () => {
    const fake = structured()
    const err = (await runStructured(
      fake,
      withOptions({ cachedContent: HANDLE }),
    )) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('allowSchemaWithSearch')
    expect(err.message).toContain('cache handle')
    expect(fake.calls).toHaveLength(0)
  })

  it('with allowSchemaWithSearch the cached Search call dispatches and fails closed without grounding', async () => {
    const fake = structured()
    const err = (await runStructured(
      fake,
      withOptions({ cachedContent: HANDLE, allowSchemaWithSearch: true }),
    )) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.reason).toBe('grounding_missing')
    expect(err.retryable).toBe(false)
    expect(fake.calls).toHaveLength(1)
    const config = (fake.calls[0] as { config: Record<string, unknown> }).config
    expect(config['cachedContent']).toBe(CACHE)
    expect(config['tools']).toBeUndefined()
  })

  it('with allowSchemaWithSearch and a response that proves Search ran, the structured answer is returned', async () => {
    const fake = structured(grounding(['q']))
    const result = (await runStructured(
      fake,
      withOptions({ cachedContent: HANDLE, allowSchemaWithSearch: true }),
    )) as { rawStructured: unknown; usage: { details: Record<string, number> } }
    expect(result.rawStructured).toEqual({ answer: 'x' })
    expect(result.usage.details['web_search_calls']).toBe(1)
  })

  it('a handle that holds googleSearch on a model never measured with a schema has nothing to opt into', async () => {
    const fake = structured()
    const model = 'gemini-2.5-flash'
    const err = (await runStructured(
      fake,
      withOptions(
        { cachedContent: HANDLE, allowSchemaWithSearch: true },
        {
          model,
          modelDescriptor: defaultGeminiRegistry.resolve('google', model)!,
        },
      ),
    )) as LlmError
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('no live capture')
    expect(fake.calls).toHaveLength(0)
  })

  it('a handle without a search tool with a schema is not blocked', async () => {
    const fake = structured()
    const result = (await runStructured(
      fake,
      withOptions({ cachedContent: { cacheName: CACHE, toolKinds: ['codeExecution'] } }),
    )) as { rawStructured: unknown }
    expect(result.rawStructured).toEqual({ answer: 'x' })
  })

  it('allowSchemaWithSearch and requireGrounding are valid with a search handle, and invalid with a bare name', async () => {
    const okFake = structured(grounding(['q']))
    await expect(
      runStructured(
        okFake,
        withOptions(
          { cachedContent: HANDLE, requireGrounding: true },
          {
            outputJsonSchema: undefined as never,
          },
        ),
      ),
    ).resolves.toBeDefined()
    for (const google of [
      { cachedContent: CACHE, allowSchemaWithSearch: true },
      { cachedContent: CACHE, requireGrounding: true },
    ]) {
      const err = (await runStructured(structured(), withOptions(google))) as LlmError
      expect(err.kind).toBe('bad_request')
      expect(err.message).toContain(
        'cachedContent handle whose toolKinds lists googleSearch',
      )
    }
  })

  it('a bare cache name with a schema is allowed: unknown tools do not block a cache of documents', async () => {
    const fake = structured()
    const result = (await runStructured(fake, withOptions({ cachedContent: CACHE }))) as {
      rawStructured: unknown
      warnings: Array<{ message: string }>
    }
    expect(result.rawStructured).toEqual({ answer: 'x' })
    expect(result.warnings).toEqual([])
  })

  it('a bare cache name with a schema whose response reports search queries is returned with a loud warning and estimated pricing', async () => {
    const fake = structured(grounding(['one', 'two']))
    const result = (await runStructured(fake, withOptions({ cachedContent: CACHE }))) as {
      rawStructured: unknown
      warnings: Array<{ message: string }>
      usage: Parameters<ReturnType<typeof geminiPricingSource>['price']>[1]
    }
    expect(result.rawStructured).toEqual({ answer: 'x' })
    const text = result.warnings.map((w) => w.message).join('\n')
    expect(text).toContain('attached a response schema')
    expect(text).toContain('allowSchemaWithSearch')
    expect(text).toContain('toolKinds')
    const cost = geminiPricingSource().price(MODEL, result.usage, undefined)
    expect(cost.details.tools).toBe(28_000)
    expect(cost.confidence).toBe('estimated')
  })

  it('a bare cache name without a schema and with search queries gets only the undeclared-search note', async () => {
    const { warnings } = await run(request(CACHE), grounding(['q']))
    expect(warnings).not.toContain('attached a response schema')
  })
})
