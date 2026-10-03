/**
 * @gullabs/google — Search facts, grounding checks and grounding price (R2.2, R2.3, R2.4).
 *
 * - `providerOptions.google.allowSchemaWithSearch` / `requireGrounding`.
 * - Normalised `usage.details.web_search_requested` / `web_search_calls`,
 *   `tool_use_prompt`, and the `tools` price lane.
 * - `Citation.cited` / `textRange` from `groundingSupports`, and
 *   `providerMetadata.google.searchEntryPoint`.
 *
 * Fixtures: `grounding-schema-matrix-2026-10-03.json` and
 * `grounding-usage-fields-2026-10-03.json` are redacted live captures (ADR-013).
 * `groundingSupports` inputs follow the field layout of the Gemini API
 * `GroundingMetadata` / `Segment` reference (https://ai.google.dev/api/generate-content),
 * which measures segment offsets in UTF-8 bytes.
 *
 * All tests use fakes from @gullabs/testing: no network.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError, createClient, retryMiddleware } from '@gullabs/core'
import type { AdapterCtx, ModelDescriptor, ResolvedRequest } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry, geminiModelDescriptors } from './models.js'

const AUTH = { apiKey: 'test-key' }
const FAKE_CTX: AdapterCtx = {
  auth: AUTH,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const GEMINI_3 = 'gemini-3.6-flash'
const GEMINI_25 = 'gemini-2.5-flash'

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}
const SEARCH = { tools: [{ googleSearch: {} }] }
const messages = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Question?' }] },
]

function descriptorFor(model: string): ModelDescriptor {
  return defaultGeminiRegistry.resolve('google', model)!
}

function request(
  google: Record<string, unknown> | undefined,
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  return {
    provider: 'google',
    model: GEMINI_3,
    messages,
    config: google === undefined ? {} : { providerOptions: { google } as never },
    modelDescriptor: descriptorFor(overrides.model ?? GEMINI_3),
    ...overrides,
  }
}

function makeClient(
  fake: ReturnType<typeof makeFakeGemini>,
  sink = new RecordingSink(),
  middleware: Parameters<typeof createClient>[0]['middleware'] = [],
) {
  return createClient({
    adapters: [geminiAdapter({ client: fake })],
    pricingSources: { google: geminiPricingSource() },
    modelRegistry: defaultGeminiRegistry,
    sink,
    clock: new FakeClock(),
    ids: new FakeIds(),
    middleware,
  })
}

const grounded = (
  queries: string[] | undefined,
  extra: Record<string, unknown> = {},
) => ({
  ...(queries !== undefined ? { webSearchQueries: queries } : {}),
  groundingChunks: [{ web: { uri: 'https://a.example/x', title: 'A' } }],
  ...extra,
})

describe('providerOptions.google.allowSchemaWithSearch (R2.2)', () => {
  it('is admitted and dispatched: schema and googleSearch go out in one request', async () => {
    const fake = makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: '{"answer":"x"}',
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        groundingMetadata: grounded(['q']),
      }),
    )
    const result = await geminiAdapter({ client: fake }).run(
      request({ ...SEARCH, allowSchemaWithSearch: true }, { outputJsonSchema: SCHEMA }),
      FAKE_CTX,
    )
    const call = fake.calls[0] as {
      config?: { responseJsonSchema?: unknown; tools?: unknown[] }
    }
    expect(call.config?.responseJsonSchema).toEqual(SCHEMA)
    expect(call.config?.tools).toEqual([{ googleSearch: {} }])
    expect(result.rawStructured).toEqual({ answer: 'x' })
    expect(result.usage.details['web_search_calls']).toBe(1)
  })

  it('the descriptors that need it stay opt-in: all six Gemini 3.x are off by default', () => {
    for (const model of GEMINI_3_MODELS) {
      const descriptor = geminiModelDescriptors.find((d) => d.model === model)!
      expect(descriptor.capabilities?.structuredOutputWithTools, model).toBe(false)
    }
  })

  it('without the flag the same request is rejected, and the message names the opt-in', async () => {
    const fake = makeFakeGemini(fakeGeminiResponse({ structuredJson: '{}' }))
    const err = (await geminiAdapter({ client: fake })
      .run(request(SEARCH, { outputJsonSchema: SCHEMA }), FAKE_CTX)
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('allowSchemaWithSearch')
    expect(fake.calls).toHaveLength(0)
  })

  it('turns requireGrounding on: no metadata means grounding_missing, with the attempt usage attached', async () => {
    const fake = makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: '{"answer":"x"}',
        promptTokenCount: 100,
        candidatesTokenCount: 20,
      }),
    )
    const err = (await geminiAdapter({ client: fake })
      .run(
        request({ ...SEARCH, allowSchemaWithSearch: true }, { outputJsonSchema: SCHEMA }),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.reason).toBe('grounding_missing')
    expect(err.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
    expect(err.usage?.details['web_search_requested']).toBe(1)
  })

  it('with requireGrounding: false the call returns, with the warning and the facts in usage', async () => {
    const fake = makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: '{"answer":"x"}',
        promptTokenCount: 100,
        candidatesTokenCount: 20,
      }),
    )
    const result = await geminiAdapter({ client: fake }).run(
      request(
        { ...SEARCH, allowSchemaWithSearch: true, requireGrounding: false },
        { outputJsonSchema: SCHEMA },
      ),
      FAKE_CTX,
    )
    expect(result.rawStructured).toEqual({ answer: 'x' })
    expect(result.usage.details['web_search_requested']).toBe(1)
    expect(result.usage.details).not.toHaveProperty('web_search_calls')
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      'no groundingMetadata',
    )
  })

  it('is rejected on a model without capabilities.grounding', async () => {
    const base = descriptorFor(GEMINI_3)
    const noGrounding: ModelDescriptor = {
      ...base,
      capabilities: { ...base.capabilities, grounding: false },
    }
    const fake = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = (await geminiAdapter({ client: fake })
      .run(
        request(
          { ...SEARCH, allowSchemaWithSearch: true },
          { outputJsonSchema: SCHEMA, modelDescriptor: noGrounding },
        ),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('bad_request')
    expect(fake.calls).toHaveLength(0)
    const alone = (await geminiAdapter({ client: fake })
      .run(
        request({ allowSchemaWithSearch: true }, { modelDescriptor: noGrounding }),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(alone.kind).toBe('bad_request')
    expect(alone.message).toContain('allowSchemaWithSearch')
    expect(alone.message).toContain('does not support grounding')
  })

  it.each([
    ['without googleSearch', { allowSchemaWithSearch: true }, SCHEMA],
    ['without a schema', { ...SEARCH, allowSchemaWithSearch: true }, undefined],
  ])('rejects the flag %s before dispatch', async (_name, google, schema) => {
    const fake = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const err = (await geminiAdapter({ client: fake })
      .run(
        request(google, schema === undefined ? {} : { outputJsonSchema: schema }),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('allowSchemaWithSearch')
    expect(fake.calls).toHaveLength(0)
  })

  it('a non-boolean flag is a type error that names the field and the type, not the opt-in hint', async () => {
    const fake = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    for (const [value, type] of [
      ['yes', 'string'],
      [1, 'number'],
      [null, 'null'],
    ] as const) {
      const err = (await geminiAdapter({ client: fake })
        .run(
          request(
            { ...SEARCH, allowSchemaWithSearch: value },
            { outputJsonSchema: SCHEMA },
          ),
          FAKE_CTX,
        )
        .catch((e: unknown) => e)) as LlmError
      expect(err.kind).toBe('bad_request')
      expect(err.message).toContain('providerOptions.google.allowSchemaWithSearch')
      expect(err.message).toContain('boolean')
      expect(err.message).toContain(type)
      expect(err.message).not.toContain('is not enabled')
    }
    for (const [value, type] of [
      ['yes', 'string'],
      [1, 'number'],
    ] as const) {
      const err = (await geminiAdapter({ client: fake })
        .run(request({ ...SEARCH, requireGrounding: value }), FAKE_CTX)
        .catch((e: unknown) => e)) as LlmError
      expect(err.message).toContain('providerOptions.google.requireGrounding')
      expect(err.message).toContain(type)
    }
    expect(fake.calls).toHaveLength(0)
  })

  it.each(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'])(
    '%s: schema + search is rejected with or without the opt-in, because no capture shows Search running there',
    async (model) => {
      const descriptor = descriptorFor(model)
      expect(descriptor.capabilities?.structuredOutputWithTools).toBeUndefined()
      for (const google of [SEARCH, { ...SEARCH, allowSchemaWithSearch: true }]) {
        const fake = makeFakeGemini(fakeGeminiResponse({ structuredJson: '{}' }))
        const err = (await geminiAdapter({ client: fake })
          .run(
            request(google, {
              model,
              modelDescriptor: descriptor,
              outputJsonSchema: SCHEMA,
            }),
            FAKE_CTX,
          )
          .catch((e: unknown) => e)) as LlmError
        expect(err.kind).toBe('bad_request')
        expect(err.message).toContain('no live capture')
        expect(err.message).toContain(model)
        expect(fake.calls).toHaveLength(0)
      }
    },
  )

  it('a model that admits schema + search by default needs no flag, and requireGrounding stays opt-in there', async () => {
    const base = descriptorFor(GEMINI_3)
    const defaultOn: ModelDescriptor = {
      ...base,
      capabilities: { ...base.capabilities, structuredOutputWithTools: true },
    }
    const noMetadata = () =>
      makeFakeGemini(
        fakeGeminiResponse({ structuredJson: '{"answer":"x"}', promptTokenCount: 5 }),
      )
    const plain = await geminiAdapter({ client: noMetadata() }).run(
      request(SEARCH, { outputJsonSchema: SCHEMA, modelDescriptor: defaultOn }),
      FAKE_CTX,
    )
    expect(plain.rawStructured).toEqual({ answer: 'x' })
    const required = (await geminiAdapter({ client: noMetadata() })
      .run(
        request(
          { ...SEARCH, requireGrounding: true },
          { outputJsonSchema: SCHEMA, modelDescriptor: defaultOn },
        ),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)) as LlmError
    expect(required.reason).toBe('grounding_missing')
  })
})

const GEMINI_3_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]

describe('P4: no Gemini 3.x model is default-on (live capture, 2026-10-03)', () => {
  interface Cell {
    model: string
    withSchema: boolean
    calls: number
    metadataWithQuery: number
  }
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          './__fixtures__/grounding-schema-matrix-2026-10-03.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as { summary: Cell[] }

  it('covers every Gemini 3.x model, with and without a schema, 4 calls each', () => {
    for (const model of GEMINI_3_MODELS) {
      for (const withSchema of [true, false]) {
        const cell = fixture.summary.find(
          (c) => c.model === model && c.withSchema === withSchema,
        )
        expect(cell?.calls, `${model} schema=${withSchema}`).toBe(4)
      }
    }
  })

  it.each(GEMINI_3_MODELS)(
    '%s: structuredOutputWithTools is true only if >= 3 of 4 schema calls returned metadata with a query',
    (model) => {
      const cell = fixture.summary.find((c) => c.model === model && c.withSchema)!
      const meetsRule = cell.metadataWithQuery >= 3
      const descriptor = geminiModelDescriptors.find((d) => d.model === model)!
      expect(descriptor.capabilities?.structuredOutputWithTools === true).toBe(meetsRule)
      // The best measured case is 3.1 Pro at 2 of 4: nothing qualifies.
      expect(meetsRule).toBe(false)
    },
  )

  it('3.1 Pro is the best case with a schema, at 2 of 4', () => {
    const cell = fixture.summary.find(
      (c) => c.model === 'gemini-3.1-pro-preview' && c.withSchema,
    )!
    expect(cell.metadataWithQuery).toBe(2)
    const others = fixture.summary.filter(
      (c) => c.withSchema && c.model !== 'gemini-3.1-pro-preview',
    )
    expect(others.every((c) => c.metadataWithQuery === 0)).toBe(true)
  })
})

describe('search facts in usage (R2.3)', () => {
  const run = (
    googleOptions: Record<string, unknown> | undefined,
    groundingMetadata: unknown,
    model = GEMINI_3,
  ) =>
    geminiAdapter({
      client: makeFakeGemini(
        fakeGeminiResponse({
          text: 'answer',
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
        }),
      ),
    }).run(request(googleOptions, { model }), FAKE_CTX)

  it('counts occurrences, not unique strings', async () => {
    const result = await run(SEARCH, grounded(['same', 'same', 'same']))
    expect(result.usage.details['web_search_requested']).toBe(1)
    expect(result.usage.details['web_search_calls']).toBe(3)
  })

  it('records an explicit zero as a known count', async () => {
    const result = await run(SEARCH, grounded([]))
    expect(result.usage.details['web_search_calls']).toBe(0)
  })

  it('leaves the count absent when the response has no metadata or no query list', async () => {
    const none = await run(SEARCH, undefined)
    expect(none.usage.details).not.toHaveProperty('web_search_calls')
    expect(none.warnings.map((w) => w.message).join('\n')).toContain(
      'no groundingMetadata',
    )
    const noList = await run(SEARCH, grounded(undefined))
    expect(noList.usage.details).not.toHaveProperty('web_search_calls')
    expect(noList.warnings.map((w) => w.message).join('\n')).toContain(
      'no webSearchQueries',
    )
  })

  it('a call that did not request search carries neither fact nor warning, even with metadata', async () => {
    const result = await run(undefined, grounded(['q']))
    expect(result.usage.details).not.toHaveProperty('web_search_requested')
    expect(result.usage.details).not.toHaveProperty('web_search_calls')
    expect(result.warnings).toEqual([])
  })

  it('a successful grounded call raises no warning', async () => {
    const result = await run(SEARCH, grounded(['q']))
    expect(result.warnings).toEqual([])
  })

  it('records tool_use_prompt whenever the provider reports it, search or not', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini(
        fakeGeminiResponse({
          text: 'answer',
          promptTokenCount: 44,
          candidatesTokenCount: 102,
          toolUsePromptTokenCount: 77,
          totalTokenCount: 223,
        }),
      ),
    })
    const result = await adapter.run(request(undefined), FAKE_CTX)
    expect(result.usage.details['tool_use_prompt']).toBe(77)
    expect(result.usage.inputTokens).toBe(44)
  })
})

describe('requireGrounding fails closed (R2.3, D5)', () => {
  const generate = (
    response: ReturnType<typeof fakeGeminiResponse>,
    options: Record<string, unknown> = { ...SEARCH, requireGrounding: true },
  ) => {
    const sink = new RecordingSink()
    const client = makeClient(makeFakeGemini(response), sink)
    return {
      sink,
      promise: client.generate(
        {
          provider: 'google',
          model: GEMINI_3,
          messages,
          config: { providerOptions: { google: options } as never },
        },
        { auth: AUTH },
      ),
    }
  }
  const response = (groundingMetadata?: unknown) =>
    fakeGeminiResponse({
      text: 'answer',
      promptTokenCount: 1000,
      candidatesTokenCount: 100,
      ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
    })

  it.each([
    ['absent metadata', undefined],
    ['metadata with no query list', grounded(undefined)],
    ['metadata with zero queries', grounded([])],
  ])(
    '%s: server, retryable, grounding_missing, billed row with usage',
    async (_n, gm) => {
      const { sink, promise } = generate(response(gm))
      const err = (await promise.catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(true)
      expect(err.reason).toBe('grounding_missing')
      expect(err.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 })
      expect(err.usage?.details['web_search_requested']).toBe(1)
      const row = sink.records[0]!
      expect(row.status).toBe('api_error')
      expect(row.errorReason).toBe('grounding_missing')
      expect(row.inputTokens).toBe(1000)
      expect(row.costMicroUsd).toBeGreaterThan(0)
    },
  )

  it.each([[['']], [[null]]])(
    'a query list of %j names no query: grounding_missing, and no fee is charged for it',
    async (queries) => {
      const { sink, promise } = generate(
        response(grounded(queries as unknown as string[])),
        SEARCH,
      )
      const result = await promise
      expect(result.usage.details).not.toHaveProperty('web_search_calls')
      expect(result.cost?.details.tools).toBe(0)
      const required = generate(response(grounded(queries as unknown as string[])))
      const err = (await required.promise.catch((e: unknown) => e)) as LlmError
      expect(err.reason).toBe('grounding_missing')
      expect(sink.records).toHaveLength(1)
    },
  )

  it('positive evidence (metadata with at least one query) passes', async () => {
    const { promise } = generate(response(grounded(['q'])))
    const result = await promise
    expect(result.text).toBe('answer')
    expect(result.usage.details['web_search_calls']).toBe(1)
  })

  it('a retry that grounds succeeds after a billed failed attempt, both rows kept', async () => {
    const sink = new RecordingSink()
    const client = makeClient(
      makeFakeGemini([response(), response(grounded(['q']))]),
      sink,
      [retryMiddleware({ maxAttempts: 2, baseDelayMs: 1 }, { sleep: async () => {} })],
    )
    const result = await client.generate(
      {
        provider: 'google',
        model: GEMINI_3,
        messages,
        config: {
          providerOptions: { google: { ...SEARCH, requireGrounding: true } } as never,
        },
      },
      { auth: AUTH },
    )
    expect(result.text).toBe('answer')
    expect(sink.records.map((r) => r.errorReason)).toEqual([
      'grounding_missing',
      undefined,
    ])
    expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
  })

  it('off by default: without the option a response with no metadata is returned', async () => {
    const { promise } = generate(response(), SEARCH)
    expect((await promise).text).toBe('answer')
  })

  it('requireGrounding: true without googleSearch is rejected before dispatch', async () => {
    const fake = makeFakeGemini(response())
    const err = (await geminiAdapter({ client: fake })
      .run(request({ requireGrounding: true }), FAKE_CTX)
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('bad_request')
    expect(err.message).toContain('requireGrounding')
    expect(fake.calls).toHaveLength(0)
    const bad = (await geminiAdapter({ client: fake })
      .run(request({ ...SEARCH, requireGrounding: 1 }), FAKE_CTX)
      .catch((e: unknown) => e)) as LlmError
    expect(bad.kind).toBe('bad_request')
  })
})

describe('requireGrounding: retry policy and finish reasons (R2.2 audit)', () => {
  const OPT_IN = { ...SEARCH, allowSchemaWithSearch: true }
  const retrying = (responses: ReturnType<typeof fakeGeminiResponse>[]) => {
    const sink = new RecordingSink()
    const fake = makeFakeGemini(responses)
    const client = makeClient(fake, sink, [
      retryMiddleware({ maxAttempts: 3, baseDelayMs: 1 }, { sleep: async () => {} }),
    ])
    return { sink, fake, client }
  }
  const call = (
    client: ReturnType<typeof makeClient>,
    google: Record<string, unknown>,
    schema?: object,
  ) =>
    client
      .generate(
        {
          provider: 'google',
          model: GEMINI_3,
          messages,
          ...(schema !== undefined ? { output: { jsonSchema: schema } } : {}),
          config: { providerOptions: { google } as never },
        } as never,
        { auth: AUTH },
      )
      .catch((e: unknown) => e as LlmError)
  const noMetadata = (extra: { finishReason?: string; text?: string } = {}) =>
    fakeGeminiResponse({
      text: extra.text ?? '{"answer":"x"}',
      promptTokenCount: 1000,
      candidatesTokenCount: 100,
      ...(extra.finishReason !== undefined ? { finishReason: extra.finishReason } : {}),
    })

  it('with a response schema the miss is not retryable: the same schema + Search call keeps missing', async () => {
    const { sink, fake, client } = retrying([noMetadata(), noMetadata(), noMetadata()])
    const err = (await call(client, OPT_IN, SCHEMA)) as LlmError
    expect(err.reason).toBe('grounding_missing')
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    // One attempt, one billed row; the retry middleware did not spend two more.
    expect(fake.calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.errorReason).toBe('grounding_missing')
    expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
  })

  it('without a schema the miss stays retryable (4 of 4 grounded in the capture)', async () => {
    const { sink, fake, client } = retrying([
      noMetadata({ text: 'a' }),
      noMetadata({ text: 'a' }),
      noMetadata({ text: 'a' }),
    ])
    const err = (await call(client, { ...SEARCH, requireGrounding: true })) as LlmError
    expect(err.reason).toBe('grounding_missing')
    expect(err.retryable).toBe(true)
    expect(fake.calls).toHaveLength(3)
    expect(sink.records).toHaveLength(3)
  })

  it('a schema call with an explicit requireGrounding is also non-retryable', async () => {
    const { fake, client } = retrying([noMetadata(), noMetadata()])
    const err = (await call(
      client,
      { ...SEARCH, allowSchemaWithSearch: true, requireGrounding: true },
      SCHEMA,
    )) as LlmError
    expect(err.retryable).toBe(false)
    expect(fake.calls).toHaveLength(1)
  })

  it.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY'])(
    '%s with no grounding evidence surfaces content_filter, not grounding_missing, in one attempt',
    async (finishReason) => {
      const { sink, fake, client } = retrying([
        noMetadata({ text: 'x', finishReason }),
        noMetadata({ text: 'x', finishReason }),
        noMetadata({ text: 'x', finishReason }),
      ])
      const err = (await call(client, { ...SEARCH, requireGrounding: true })) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('content_filter')
      expect(err.retryable).toBe(false)
      expect(err.reason).not.toBe('grounding_missing')
      expect(err.message).toContain(finishReason)
      expect(err.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 })
      expect(fake.calls).toHaveLength(1)
      expect(sink.records).toHaveLength(1)
      expect(sink.records[0]!.status).toBe('content_filter')
      expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
    },
  )

  it('a filtered candidate that does show Search ran is returned as without the flag', async () => {
    const { client } = retrying([
      fakeGeminiResponse({
        text: 'x',
        finishReason: 'SAFETY',
        promptTokenCount: 10,
        groundingMetadata: grounded(['q']),
      }),
    ])
    const result = await call(client, { ...SEARCH, requireGrounding: true })
    expect((result as { finishReason?: string }).finishReason).toBe('content_filter')
  })

  it('MAX_TOKENS with no evidence returns finishReason length: the host sees the truncation', async () => {
    const { fake, client } = retrying([
      noMetadata({ text: '', finishReason: 'MAX_TOKENS' }),
    ])
    const result = (await call(client, { ...SEARCH, requireGrounding: true })) as {
      finishReason?: string
    }
    expect(result.finishReason).toBe('length')
    expect(fake.calls).toHaveLength(1)
  })

  it('STOP with no evidence is still grounding_missing', async () => {
    const stop = noMetadata({ text: 'a', finishReason: 'STOP' })
    const { client } = retrying([stop, stop, stop])
    const err = (await call(client, { ...SEARCH, requireGrounding: true })) as LlmError
    expect(err.reason).toBe('grounding_missing')
  })
})

describe('the grounding price lane (R2.3)', () => {
  const source = geminiPricingSource()
  const usage = (details: Record<string, number>) => ({
    inputTokens: 1000,
    outputTokens: 100,
    details,
    raw: null,
  })

  it('Gemini 3 bills each query: calls x 14_000 uUSD on the tools lane, estimated', () => {
    const plain = source.price(GEMINI_3, usage({}))
    const two = source.price(
      GEMINI_3,
      usage({ web_search_requested: 1, web_search_calls: 2 }),
    )
    expect(two.details.tools).toBe(28_000)
    expect(two.microUsd).toBe(plain.microUsd! + 28_000)
    expect(two.details.input + two.details.cached + two.details.output + 28_000).toBe(
      two.microUsd,
    )
    expect(two.confidence).toBe('estimated')
    expect(plain.confidence).toBe('exact')
  })

  it('Gemini 2.5 bills once per grounded prompt: 35_000 uUSD however many queries ran', () => {
    for (const calls of [1, 3]) {
      const cost = source.price(
        GEMINI_25,
        usage({ web_search_requested: 1, web_search_calls: calls }),
      )
      expect(cost.details.tools).toBe(35_000)
      expect(cost.confidence).toBe('estimated')
    }
  })

  it('requested with the count unknown: tools lane unpriced (0) and estimated', () => {
    for (const model of [GEMINI_3, GEMINI_25]) {
      const plain = source.price(model, usage({}))
      const cost = source.price(model, usage({ web_search_requested: 1 }))
      expect(cost.details.tools).toBe(0)
      expect(cost.microUsd).toBe(plain.microUsd)
      expect(cost.confidence).toBe('estimated')
    }
  })

  it('requested with a known zero count: Search did not run, nothing to add, exact', () => {
    for (const model of [GEMINI_3, GEMINI_25]) {
      const cost = source.price(
        model,
        usage({ web_search_requested: 1, web_search_calls: 0 }),
      )
      expect(cost.details.tools).toBe(0)
      expect(cost.confidence).toBe('exact')
    }
  })

  it('the facts are ignored when search was not requested', () => {
    const cost = source.price(GEMINI_3, usage({ web_search_calls: 5 }))
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('exact')
  })

  it('every priced model has a grounding rate, and an unpriced model stays unpriced', () => {
    for (const model of source.listModels()) {
      const cost = source.price(
        model,
        usage({ web_search_requested: 1, web_search_calls: 1 }),
      )
      expect(cost.details.tools, model).toBeGreaterThan(0)
    }
    const unknown = source.price(
      'gemini-9-unknown',
      usage({ web_search_requested: 1, web_search_calls: 1 }),
    )
    expect(unknown.microUsd).toBeNull()
    expect(unknown.details.tools).toBe(0)
  })

  it('the tier changes the token lanes only; the grounding fee is the same', () => {
    const standard = source.price(
      GEMINI_3,
      usage({ web_search_requested: 1, web_search_calls: 1 }),
    )
    const flex = source.price(
      GEMINI_3,
      usage({ web_search_requested: 1, web_search_calls: 1 }),
      'flex',
    )
    expect(flex.details.tools).toBe(standard.details.tools)
    expect(flex.microUsd).toBeLessThan(standard.microUsd!)
  })

  it('a grounded call through the client is priced and estimated, tools lane in cost.details', async () => {
    const client = makeClient(
      makeFakeGemini(
        fakeGeminiResponse({
          text: 'answer',
          promptTokenCount: 1000,
          candidatesTokenCount: 100,
          groundingMetadata: grounded(['a', 'b']),
        }),
      ),
    )
    const result = await client.generate(
      {
        provider: 'google',
        model: GEMINI_3,
        messages,
        config: { providerOptions: { google: SEARCH } as never },
      },
      { auth: AUTH },
    )
    expect(result.cost?.details.tools).toBe(28_000)
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.warnings).toEqual([])
  })
})

describe('live Gemini 2.5 usage with a repeated query (P5 capture, 2026-10-03)', () => {
  interface UsageCall {
    model: string
    usage: {
      promptTokenCount: number
      candidatesTokenCount: number
      thoughtsTokenCount?: number
      toolUsePromptTokenCount?: number
      totalTokenCount: number
    }
    webSearchQueries: string[]
  }
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('./__fixtures__/grounding-usage-fields-2026-10-03.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { gemini25and3: UsageCall[] }

  const callFor = (model: string) => fixture.gemini25and3.find((c) => c.model === model)!

  it.each(['gemini-2.5-flash', 'gemini-2.5-pro'])(
    '%s: occurrences are counted, tool-use tokens are recorded, and the call is estimated with a warning',
    async (model) => {
      const call = callFor(model)
      expect(call.webSearchQueries.length).toBe(3)
      expect(new Set(call.webSearchQueries).size).toBe(1)
      const sink = new RecordingSink()
      const client = makeClient(
        makeFakeGemini({
          candidates: [
            {
              content: { parts: [{ text: 'answer' }] },
              groundingMetadata: { webSearchQueries: call.webSearchQueries },
            },
          ],
          usageMetadata: call.usage,
        }),
        sink,
      )
      const result = await client.generate(
        {
          provider: 'google',
          model,
          messages,
          config: { providerOptions: { google: SEARCH } as never },
        },
        { auth: AUTH },
      )
      expect(result.usage.details['web_search_calls']).toBe(3)
      expect(result.usage.details['tool_use_prompt']).toBe(
        call.usage.toolUsePromptTokenCount,
      )
      // Grounded prompt, not per query: one 35_000 uUSD fee for three queries.
      expect(result.cost?.details.tools).toBe(35_000)
      expect(result.cost?.confidence).toBe('estimated')
      // total (incl. tool-use tokens) is more than input + output.
      expect(call.usage.totalTokenCount).toBeGreaterThan(
        call.usage.promptTokenCount +
          call.usage.candidatesTokenCount +
          (call.usage.thoughtsTokenCount ?? 0),
      )
      expect(result.warnings.map((w) => w.message).join('\n')).toContain(
        'greater than inputTokens + outputTokens',
      )
      expect(JSON.stringify(sink.records[0]!.warnings)).toContain(
        'greater than inputTokens + outputTokens',
      )
    },
  )

  it('Gemini 3.x reported one query and no tool-use tokens, and its total matches input + output', () => {
    const gemini3 = fixture.gemini25and3.filter((c) => c.model.startsWith('gemini-3'))
    expect(gemini3.length).toBeGreaterThan(0)
    for (const call of gemini3) {
      expect(call.usage.toolUsePromptTokenCount).toBeUndefined()
      expect(call.usage.totalTokenCount).toBe(
        call.usage.promptTokenCount +
          call.usage.candidatesTokenCount +
          (call.usage.thoughtsTokenCount ?? 0),
      )
    }
  })
})

describe('citations carry cited and textRange from groundingSupports (R2.4)', () => {
  const chunks = [
    { web: { uri: 'https://a.example/x', title: 'A' } },
    { web: { uri: 'https://b.example/y', title: 'B' } },
    { web: { uri: 'https://c.example/z', title: 'C' } },
  ]
  const generate = (text: string, groundingMetadata: unknown, thoughtText?: string) =>
    geminiAdapter({
      client: makeFakeGemini(
        fakeGeminiResponse({
          text,
          ...(thoughtText !== undefined ? { thoughtText } : {}),
          promptTokenCount: 10,
          candidatesTokenCount: 10,
          groundingMetadata,
        }),
      ),
    }).run(request(SEARCH), FAKE_CTX)

  it('sets cited per chunk and the first supported range, converting UTF-8 bytes to UTF-16 offsets', async () => {
    // "Café is open." is 14 bytes but 13 UTF-16 units; "Bye." starts at byte 15.
    const text = 'Café is open. Bye.'
    const result = await generate(text, {
      webSearchQueries: ['q'],
      groundingChunks: chunks,
      groundingSupports: [
        { segment: { endIndex: 14 }, groundingChunkIndices: [0] },
        { segment: { startIndex: 15, endIndex: 19 }, groundingChunkIndices: [1, 0] },
      ],
    })
    expect(result.citations).toEqual([
      {
        url: 'https://a.example/x',
        title: 'A',
        sourceName: 'A',
        cited: true,
        textRange: { start: 0, end: 13 },
      },
      {
        url: 'https://b.example/y',
        title: 'B',
        sourceName: 'B',
        cited: true,
        textRange: { start: 14, end: 18 },
      },
      { url: 'https://c.example/z', title: 'C', sourceName: 'C', cited: false },
    ])
    const first = result.citations![0]!.textRange!
    expect(text.slice(first.start, first.end)).toBe('Café is open.')
  })

  it('a thought part before the answer shifts partIndex but not the range in the answer text', async () => {
    const result = await generate(
      'Answer here.',
      {
        webSearchQueries: ['q'],
        groundingChunks: chunks,
        groundingSupports: [
          {
            segment: { partIndex: 1, startIndex: 7, endIndex: 11 },
            groundingChunkIndices: [2],
          },
        ],
      },
      'thinking about it',
    )
    const c = result.citations!.find((x) => x.url.includes('c.example'))!
    expect(c.textRange).toEqual({ start: 7, end: 11 })
    expect(result.text!.slice(7, 11)).toBe('here')
  })

  it('without groundingSupports the provider says nothing about citing: both fields absent', async () => {
    const result = await generate('text', {
      webSearchQueries: ['q'],
      groundingChunks: chunks,
    })
    for (const citation of result.citations!) {
      expect(citation).not.toHaveProperty('cited')
      expect(citation).not.toHaveProperty('textRange')
    }
  })

  it('an offset that splits a character, or names a part that is not answer text, gives no range but stays cited', async () => {
    const result = await generate('Café', {
      webSearchQueries: ['q'],
      groundingChunks: chunks,
      groundingSupports: [
        // byte 4 is inside the two-byte "é"
        { segment: { endIndex: 4 }, groundingChunkIndices: [0] },
        { segment: { partIndex: 5, endIndex: 2 }, groundingChunkIndices: [1] },
      ],
    })
    expect(result.citations![0]).toMatchObject({ cited: true })
    expect(result.citations![0]).not.toHaveProperty('textRange')
    expect(result.citations![1]).toMatchObject({ cited: true })
    expect(result.citations![1]).not.toHaveProperty('textRange')
  })

  it('chunks that share a URL merge into one citation', async () => {
    const result = await generate('Hello world.', {
      webSearchQueries: ['q'],
      groundingChunks: [
        { web: { uri: 'https://a.example/x', title: 'A' } },
        { web: { uri: 'https://a.example/x', title: 'A again' } },
      ],
      groundingSupports: [{ segment: { endIndex: 5 }, groundingChunkIndices: [1] }],
    })
    expect(result.citations).toEqual([
      {
        url: 'https://a.example/x',
        title: 'A',
        sourceName: 'A',
        cited: true,
        textRange: { start: 0, end: 5 },
      },
    ])
  })
})

describe('providerMetadata.google.searchEntryPoint (R2.4)', () => {
  const run = (groundingMetadata: unknown) =>
    geminiAdapter({
      client: makeFakeGemini(
        fakeGeminiResponse({ text: 'a', promptTokenCount: 1, groundingMetadata }),
      ),
    }).run(request(SEARCH), FAKE_CTX)

  it('surfaces the Search Suggestions widget Google requires a grounded answer to show', async () => {
    const entry = { renderedContent: '<div class="chip">q</div>' }
    const result = await run(grounded(['q'], { searchEntryPoint: entry }))
    expect(result.providerMetadata).toMatchObject({ google: { searchEntryPoint: entry } })
    // The raw payload is still there.
    expect(result.providerMetadata).toMatchObject({
      groundingMetadata: { searchEntryPoint: entry },
    })
  })

  it('is absent when the response has none', async () => {
    const result = await run(grounded(['q']))
    expect(result.providerMetadata).not.toHaveProperty('google')
  })
})
