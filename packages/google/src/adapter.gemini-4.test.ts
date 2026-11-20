/**
 * Gemini 4 (Carbon, Argon, Neon, Hydrogen): the contract, documented and not
 * live-verified (model pages, thinking guide, Gemini 4 migration notes and the
 * pricing page under https://aistudio.google.com/docs, read 2026-11-20).
 *
 * - Level reasoning: the documented default level is sent when no effort is
 *   set (and when only includeThoughts is), `xhigh` is XHIGH on Neon and
 *   Hydrogen only, `none` / `budgetTokens` / `max` are rejected before dispatch.
 * - Final-turn rules (also on 3.5 Flash-Lite, 3.6 and 3.8 Flash), no explicit
 *   caching, no schema with Search, no Search with flex, output caps.
 * - The 20-minute default deadline on untiered and standard calls (adapter
 *   ceiling and SDK timeout); flex keeps 25 minutes.
 * - Pricing: snapshot rates, Carbon and Argon estimated with the reason as a
 *   warning, grounding per query and estimated even at zero queries.
 * - Function calling with signed replay on the wire.
 *
 * Wire tests run the real `@google/genai` 3.6.1 on a stubbed `fetch`; the
 * response bodies are built in the documented REST shape, not captured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import type {
  AdapterCtx,
  JsonValue,
  Message,
  ModelDescriptor,
  ResolvedRequest,
} from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'

import { geminiAdapter } from './adapter.js'
import { GoogleCacheStore } from './cache-store.js'
import { FLEX_DEFAULT_TIMEOUT_MS, TRANSPORT_TIMEOUT_BUFFER_MS } from './client.js'
import type { GeminiClientLike, GeminiResponseShape } from './client.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry } from './models.js'
import { GEMINI_4_DEFAULT_TIMEOUT_MS } from './request-rules.js'

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const AUTH = { apiKey: 'test-key' }

const MEDIUM_DEFAULT = ['gemini-4-carbon', 'gemini-4-argon'] as const
const HIGH_DEFAULT = ['gemini-4-neon', 'gemini-4-hydrogen'] as const
const GEMINI_4 = [...MEDIUM_DEFAULT, ...HIGH_DEFAULT] as const

const descriptor = (model: string): ModelDescriptor =>
  defaultGeminiRegistry.resolve('google', model)!
const USER: Message = { role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }

function request(
  model: string,
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  return {
    provider: 'google',
    model,
    messages: [USER],
    config: {},
    modelDescriptor: descriptor(model),
    ...overrides,
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<LlmError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(LlmError)
  return err as LlmError
}

// ---------------------------------------------------------------------------
// Real SDK on a stubbed fetch
// ---------------------------------------------------------------------------

interface Sent {
  url: string
  body: Record<string, unknown>
}
let sent: Sent[]
let responses: Array<{ status: number; body: unknown }>

beforeEach(() => {
  sent = []
  responses = []
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
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

const ok = (parts: unknown[] = [{ text: 'hi' }]) => ({
  status: 200,
  body: {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  },
})
const thinkingConfigSent = (index = 0): unknown =>
  (sent[index]!.body['generationConfig'] as { thinkingConfig?: unknown } | undefined)
    ?.thinkingConfig

// ---------------------------------------------------------------------------

describe('registry and schemas', () => {
  it.each(GEMINI_4)('%s resolves with the documented capabilities', (model) => {
    const d = descriptor(model)
    expect(d.provider).toBe('google')
    expect(d.pricingFamily).toBe(model)
    expect(d.capabilities).toMatchObject({
      reasoningApi: 'level',
      sampling: 'fixed',
      caching: { explicit: false, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      nativeStructuredOutput: true,
      providerState: true,
      continuation: 'history',
      serviceTiers: ['flex', 'standard'],
    })
    expect(d.capabilities?.structuredOutputWithTools).toBeUndefined()
    expect(d.capabilities?.admittedReasoningEfforts).toEqual(
      (HIGH_DEFAULT as readonly string[]).includes(model)
        ? ['low', 'medium', 'high', 'xhigh']
        : ['low', 'medium', 'high'],
    )
    expect(d.shutdownDate).toBeUndefined()
  })

  it.each(GEMINI_4)(
    '%s schema admits no cachedContent, allowSchemaWithSearch, sampling or budget, and no Search on flex',
    (model) => {
      const schema = descriptor(model).configSchema
      const parse = (config: unknown) => schema.safeParse(config).success
      expect(parse({})).toBe(true)
      expect(
        parse({ providerOptions: { google: { cachedContent: 'cachedContents/x' } } }),
      ).toBe(false)
      expect(
        parse({ providerOptions: { google: { allowSchemaWithSearch: true } } }),
      ).toBe(false)
      for (const key of ['temperature', 'topP', 'topK']) {
        expect(parse({ [key]: 0.5 }), key).toBe(false)
      }
      expect(parse({ reasoning: { budgetTokens: 1024 } })).toBe(false)
      expect(parse({ reasoning: { effort: 'none' } })).toBe(false)
      expect(parse({ reasoning: { effort: 'max' } })).toBe(false)
      const search = { providerOptions: { google: { tools: [{ googleSearch: {} }] } } }
      expect(parse(search)).toBe(true)
      expect(parse({ ...search, serviceTier: 'standard' })).toBe(true)
      expect(parse({ ...search, serviceTier: 'flex' })).toBe(false)
      expect(
        parse({
          serviceTier: 'flex',
          providerOptions: { google: { requireGrounding: true } },
        }),
      ).toBe(false)
      expect(
        parse({
          serviceTier: 'flex',
          providerOptions: { google: { flexFallback: false } },
        }),
      ).toBe(true)
    },
  )

  it('xhigh is admitted on Neon and Hydrogen only', () => {
    for (const model of GEMINI_4) {
      expect(
        descriptor(model).configSchema.safeParse({ reasoning: { effort: 'xhigh' } })
          .success,
        model,
      ).toBe((HIGH_DEFAULT as readonly string[]).includes(model))
    }
  })

  it.each([
    ['gemini-4-carbon', 32_768],
    ['gemini-4-argon', 32_768],
    ['gemini-4-neon', 65_536],
    ['gemini-4-hydrogen', 65_536],
  ] as const)('%s caps maxOutputTokens at %i', (model, cap) => {
    const schema = descriptor(model).configSchema
    expect(schema.safeParse({ maxOutputTokens: cap }).success).toBe(true)
    expect(schema.safeParse({ maxOutputTokens: cap + 1 }).success).toBe(false)
  })
})

describe('reasoning on the wire', () => {
  it.each([
    ...MEDIUM_DEFAULT.map((m) => [m, 'MEDIUM'] as const),
    ...HIGH_DEFAULT.map((m) => [m, 'HIGH'] as const),
  ])('%s with no effort sends the documented default %s', async (model, level) => {
    responses.push(ok())
    await geminiAdapter().run(request(model), CTX)
    expect(thinkingConfigSent()).toEqual({ thinkingLevel: level })
  })

  it.each([
    ...MEDIUM_DEFAULT.map((m) => [m, 'MEDIUM'] as const),
    ...HIGH_DEFAULT.map((m) => [m, 'HIGH'] as const),
  ])('%s with includeThoughts only sends the default %s too', async (model, level) => {
    responses.push(ok())
    await geminiAdapter().run(
      request(model, { config: { reasoning: { includeThoughts: true } } }),
      CTX,
    )
    expect(thinkingConfigSent()).toEqual({ thinkingLevel: level, includeThoughts: true })
  })

  it.each(HIGH_DEFAULT)('%s maps xhigh to ThinkingLevel XHIGH', async (model) => {
    responses.push(ok())
    await geminiAdapter().run(
      request(model, { config: { reasoning: { effort: 'xhigh' } } }),
      CTX,
    )
    expect(thinkingConfigSent()).toEqual({ thinkingLevel: 'XHIGH' })
  })

  it.each(GEMINI_4)('%s sends an explicit effort as given', async (model) => {
    responses.push(ok())
    await geminiAdapter().run(
      request(model, { config: { reasoning: { effort: 'low' } } }),
      CTX,
    )
    expect(thinkingConfigSent()).toEqual({ thinkingLevel: 'LOW' })
  })

  it('a model without a documented default sends no level when no effort is set', async () => {
    responses.push(ok())
    await geminiAdapter().run(request('gemini-3.8-flash'), CTX)
    expect(thinkingConfigSent()).toBeUndefined()
  })

  const UNSUPPORTED: Array<readonly [string, Record<string, unknown>]> = [
    ...GEMINI_4.map((m) => [m, { effort: 'none' }] as const),
    ...GEMINI_4.map((m) => [m, { effort: 'max' }] as const),
    ...GEMINI_4.map((m) => [m, { budgetTokens: 2048 }] as const),
    ...MEDIUM_DEFAULT.map((m) => [m, { effort: 'xhigh' }] as const),
  ]
  it.each(UNSUPPORTED)(
    '%s rejects reasoning %o before dispatch, at the adapter and through the client',
    async (model, reasoning) => {
      const direct = await rejectionOf(
        geminiAdapter().run(
          request(model, { config: { reasoning } as ResolvedRequest['config'] }),
          CTX,
        ),
      )
      expect(direct).toMatchObject({ kind: 'bad_request', retryable: false })
      const client = createClient({
        adapters: [geminiAdapter()],
        modelRegistry: defaultGeminiRegistry,
        pricingSources: { google: geminiPricingSource() },
      })
      const viaClient = await rejectionOf(
        client.generate(
          { provider: 'google', model, messages: [USER], config: { reasoning } as never },
          { auth: AUTH },
        ),
      )
      expect(viaClient.kind).toBe('bad_request')
      expect(sent).toHaveLength(0)
    },
  )
})

describe('final-turn rules, before dispatch', () => {
  const MODEL_LAST: Message[] = [
    USER,
    { role: 'assistant', parts: [{ kind: 'text', text: 'Prefilled start' }] },
  ]

  it.each([...GEMINI_4, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'])(
    '%s rejects a request whose last non-empty turn is a model turn',
    async (model) => {
      const err = await rejectionOf(
        geminiAdapter().run(request(model, { messages: MODEL_LAST }), CTX),
      )
      expect(err).toMatchObject({
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
      expect(err.issues?.[0]?.path).toBe('messages[1]')
      expect(sent).toHaveLength(0)
    },
  )

  it.each(['gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'])(
    '%s has no such documented rule and sends the request',
    async (model) => {
      responses.push(ok())
      await geminiAdapter().run(request(model, { messages: MODEL_LAST }), CTX)
      expect(sent).toHaveLength(1)
    },
  )

  it('3.8 Flash rejects a final user turn without non-empty text', async () => {
    for (const parts of [
      [{ kind: 'text' as const, text: '' }],
      [{ kind: 'inline-media' as const, mimeType: 'image/png', data: 'AAAA' }],
    ]) {
      const err = await rejectionOf(
        geminiAdapter().run(
          request('gemini-3.8-flash', { messages: [{ role: 'user', parts }] }),
          CTX,
        ),
      )
      expect(err.kind).toBe('bad_request')
      expect(err.message).toContain('non-empty text')
    }
    expect(sent).toHaveLength(0)
  })

  it('3.8 Flash accepts a final turn of function responses (the 2026-10-03 capture shows it accepted)', async () => {
    const descriptor38 = descriptor('gemini-3.8-flash')
    const tools = [
      {
        name: 'lookup',
        description: 'Look something up',
        inputJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]
    responses.push(
      ok([
        {
          functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } },
          thoughtSignature: 'c2ln',
        },
      ]),
    )
    const first = await geminiAdapter().run(
      request('gemini-3.8-flash', { tools, modelDescriptor: descriptor38 }),
      CTX,
    )
    responses.push(ok())
    await geminiAdapter().run(
      request('gemini-3.8-flash', {
        tools,
        messages: [
          USER,
          first.message,
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'call_1',
                toolName: 'lookup',
                result: { a: 1 },
              },
            ],
          },
        ],
        transientProviderState: first.transientProviderState as JsonValue,
      }),
      CTX,
    )
    expect(sent).toHaveLength(2)
  })

  describe('3.8 Flash final turn with a tool result: only a turn made entirely of tool results is exempt', () => {
    const tools = [
      {
        name: 'lookup',
        description: 'Look something up',
        inputJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]
    const RESULT = {
      kind: 'tool-result' as const,
      toolCallId: 'call_1',
      toolName: 'lookup',
      result: { a: 1 },
    }
    const IMAGE = { kind: 'inline-media' as const, mimeType: 'image/png', data: 'AAAA' }

    /** Turn 1 (a signed call), then the final turn built from `parts`. */
    async function finalTurn(parts: Message['parts']): Promise<unknown> {
      responses.push(
        ok([
          {
            functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } },
            thoughtSignature: 'c2ln',
          },
        ]),
      )
      const first = await geminiAdapter().run(request('gemini-3.8-flash', { tools }), CTX)
      responses.push(ok())
      return geminiAdapter()
        .run(
          request('gemini-3.8-flash', {
            tools,
            messages: [USER, first.message, { role: 'user', parts }],
            transientProviderState: first.transientProviderState as JsonValue,
          }),
          CTX,
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        )
    }

    it('only tool results: dispatched', async () => {
      expect(await finalTurn([RESULT])).toBeUndefined()
      expect(sent).toHaveLength(2)
    })

    it('a tool result and an image without text: bad_request naming the turn, not dispatched', async () => {
      const err = (await finalTurn([RESULT, IMAGE])) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
      expect(err.issues?.[0]?.path).toBe('messages[2]')
      expect(sent).toHaveLength(1)
    })

    it('a tool result, an image and non-empty text: dispatched', async () => {
      expect(
        await finalTurn([
          RESULT,
          IMAGE,
          { kind: 'text', text: 'Describe the image too.' },
        ]),
      ).toBeUndefined()
      expect(sent).toHaveLength(2)
    })

    it('a tool result, an empty-string text part and an image: bad_request (the text is not non-empty)', async () => {
      const err = (await finalTurn([
        RESULT,
        { kind: 'text', text: '' },
        IMAGE,
      ])) as LlmError
      expect(err).toMatchObject({
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
      expect(err.issues?.[0]?.path).toBe('messages[2]')
      expect(sent).toHaveLength(1)
    })

    // "Non-empty" is a statement about length: a text part of length > 0
    // satisfies the documented rule. Whitespace is not examined, because the
    // documentation does not speak to it.
    it('a tool result, an image and whitespace-only text: dispatched (the text is non-empty)', async () => {
      expect(
        await finalTurn([RESULT, IMAGE, { kind: 'text', text: '  \n' }]),
      ).toBeUndefined()
      expect(sent).toHaveLength(2)
    })

    it('a tool result and whitespace-only text: dispatched (the text is non-empty)', async () => {
      expect(await finalTurn([RESULT, { kind: 'text', text: ' ' }])).toBeUndefined()
      expect(sent).toHaveLength(2)
    })

    it('a user turn of whitespace-only text alone: dispatched (the text is non-empty)', async () => {
      responses.push(ok())
      await geminiAdapter().run(
        request('gemini-3.8-flash', {
          messages: [{ role: 'user', parts: [{ kind: 'text', text: '\t ' }] }],
        }),
        CTX,
      )
      expect(sent).toHaveLength(1)
    })
  })

  it('Gemini 4 is not held to the 3.8 text rule (not documented for it)', async () => {
    responses.push(ok())
    await geminiAdapter().run(
      request('gemini-4-neon', {
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AAAA' }],
          },
        ],
      }),
      CTX,
    )
    expect(sent).toHaveLength(1)
  })
})

describe('function calling with signed replay on the wire', () => {
  it.each(GEMINI_4)(
    '%s replays the signed call and the function response with its id and name',
    async (model) => {
      const tools = [
        {
          name: 'get_weather',
          description: 'Get the weather',
          inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]
      responses.push(
        ok([
          {
            functionCall: { id: 'call_7', name: 'get_weather', args: { city: 'Rome' } },
            thoughtSignature: 'c2lnbmF0dXJl',
          },
        ]),
      )
      const first = await geminiAdapter().run(request(model, { tools }), CTX)
      expect(first.toolCalls).toEqual([
        { toolCallId: 'call_7', toolName: 'get_weather', args: { city: 'Rome' } },
      ])
      responses.push(ok())
      await geminiAdapter().run(
        request(model, {
          tools,
          messages: [
            USER,
            first.message,
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'call_7',
                  toolName: 'get_weather',
                  result: { tempC: 21 },
                },
              ],
            },
          ],
          transientProviderState: first.transientProviderState as JsonValue,
        }),
        CTX,
      )
      const contents = sent[1]!.body['contents'] as Array<{
        role: string
        parts: unknown[]
      }>
      expect(contents[1]).toEqual({
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call_7', name: 'get_weather', args: { city: 'Rome' } },
            thoughtSignature: 'c2lnbmF0dXJl',
          },
        ],
      })
      expect(contents[2]).toEqual({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_7',
              name: 'get_weather',
              response: { tempC: 21 },
            },
          },
        ],
      })
    },
  )
})

describe('no explicit caching', () => {
  it.each(GEMINI_4)(
    '%s: the adapter rejects cachedContent before dispatch',
    async (model) => {
      const err = await rejectionOf(
        geminiAdapter().run(
          request(model, {
            config: {
              providerOptions: { google: { cachedContent: 'cachedContents/x' } },
            } as ResolvedRequest['config'],
          }),
          CTX,
        ),
      )
      expect(err.kind).toBe('bad_request')
      expect(err.message).toContain('explicit-caching')
      expect(sent).toHaveLength(0)
    },
  )

  it.each([...GEMINI_4, `models/gemini-4-neon`])(
    'GoogleCacheStore.create rejects %s before its token preflight and before any request',
    async (model) => {
      const countTokens = vi.fn(async () => 10_000)
      const create = vi.fn()
      const store = new GoogleCacheStore({
        auth: AUTH,
        client: { create, update: vi.fn(), delete: vi.fn() },
        preflight: { minTokens: 4096, countTokens },
      })
      const err = await rejectionOf(store.create({ model, ttlSeconds: 60 }))
      expect(err).toMatchObject({ kind: 'bad_request', provider: 'google' })
      expect(countTokens).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('GoogleCacheStore.create still serves a model with explicit caching', async () => {
    const store = new GoogleCacheStore({
      auth: AUTH,
      client: {
        create: vi.fn(async () => ({
          name: 'cachedContents/c',
          expireTime: '2099-01-01T00:00:00Z',
        })),
        update: vi.fn(),
        delete: vi.fn(),
      },
    })
    const handle = await store.create({ model: 'gemini-3.8-flash', ttlSeconds: 60 })
    expect(handle.cacheName).toBe('cachedContents/c')
  })
})

describe('Search', () => {
  const SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  }
  const SEARCH = { tools: [{ googleSearch: {} }] }

  it.each(GEMINI_4)(
    '%s rejects a response schema with Search, with or without the opt-in',
    async (model) => {
      for (const google of [SEARCH, { ...SEARCH, allowSchemaWithSearch: true }]) {
        const err = await rejectionOf(
          geminiAdapter().run(
            request(model, {
              config: { providerOptions: { google } } as ResolvedRequest['config'],
              outputJsonSchema: SCHEMA,
            }),
            CTX,
          ),
        )
        expect(err.kind).toBe('bad_request')
        expect(err.message).toContain('no live capture')
      }
      expect(sent).toHaveLength(0)
    },
  )

  it.each(GEMINI_4)(
    '%s rejects Search with the flex tier before dispatch',
    async (model) => {
      const err = await rejectionOf(
        geminiAdapter().run(
          request(model, {
            config: {
              serviceTier: 'flex',
              providerOptions: { google: SEARCH },
            } as ResolvedRequest['config'],
          }),
          CTX,
        ),
      )
      expect(err).toMatchObject({
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
      expect(err.message).toContain('serviceTier "flex"')
      expect(sent).toHaveLength(0)
    },
  )

  it('Search with flex stays admitted on 3.8 Flash', async () => {
    responses.push(ok())
    await geminiAdapter().run(
      request('gemini-3.8-flash', {
        config: {
          serviceTier: 'flex',
          providerOptions: { google: SEARCH },
        } as ResolvedRequest['config'],
      }),
      CTX,
    )
    expect(sent).toHaveLength(1)
  })

  it.each(GEMINI_4)('%s sends Search at the standard and omitted tier', async (model) => {
    for (const serviceTier of [undefined, 'standard'] as const) {
      responses.push(ok())
      await geminiAdapter().run(
        request(model, {
          config: {
            ...(serviceTier !== undefined ? { serviceTier } : {}),
            providerOptions: { google: SEARCH },
          } as ResolvedRequest['config'],
        }),
        CTX,
      )
    }
    expect(sent.map((s) => s.body['tools'])).toEqual([
      [{ googleSearch: {} }],
      [{ googleSearch: {} }],
    ])
  })
})

describe('default deadline', () => {
  const capture = () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const timeoutOf = (i = 0) =>
      (client.calls[i] as { config: { httpOptions?: { timeout?: number } } }).config
        .httpOptions?.timeout
    const hasSignal = (i = 0) =>
      (client.calls[i] as { config: { abortSignal?: unknown } }).config.abortSignal !==
      undefined
    return { client, timeoutOf, hasSignal }
  }

  it.each(GEMINI_4)(
    '%s: untiered and standard calls get a 20-minute SDK timeout and ceiling; flex keeps 25',
    async (model) => {
      for (const [config, expected] of [
        [{}, GEMINI_4_DEFAULT_TIMEOUT_MS],
        [{ serviceTier: 'standard' }, GEMINI_4_DEFAULT_TIMEOUT_MS],
        [{ serviceTier: 'flex' }, FLEX_DEFAULT_TIMEOUT_MS],
        [{ timeoutMs: 60_000 }, 60_000 + TRANSPORT_TIMEOUT_BUFFER_MS],
      ] as const) {
        const { client, timeoutOf, hasSignal } = capture()
        await geminiAdapter({ client }).run(
          request(model, { config: config as ResolvedRequest['config'] }),
          CTX,
        )
        expect(timeoutOf(), JSON.stringify(config)).toBe(expected)
        // The adapter arms its own ceiling unless timeoutMs is set (the engine's deadline).
        expect(hasSignal(), JSON.stringify(config)).toBe(!('timeoutMs' in config))
      }
    },
  )

  it('GEMINI_4_DEFAULT_TIMEOUT_MS is 20 minutes', () => {
    expect(GEMINI_4_DEFAULT_TIMEOUT_MS).toBe(20 * 60 * 1000)
  })

  it('a model without the rule keeps no deadline untiered and 5 minutes at standard', async () => {
    const untiered = capture()
    await geminiAdapter({ client: untiered.client }).run(request('gemini-3.8-flash'), CTX)
    expect(untiered.timeoutOf()).toBeUndefined()
    expect(untiered.hasSignal()).toBe(false)
    const standard = capture()
    await geminiAdapter({ client: standard.client }).run(
      request('gemini-3.8-flash', { config: { serviceTier: 'standard' } }),
      CTX,
    )
    expect(standard.timeoutOf()).toBe(300_000)
  })

  it('the standard dispatch after a flex capacity error gets 20 minutes and says so', async () => {
    let call = 0
    const client = makeFakeGemini(() => {
      call += 1
      if (call === 1) throw { status: 503, message: 'no capacity' }
      return fakeGeminiResponse({ text: 'ok' })
    })
    const result = await geminiAdapter({ client }).run(
      request('gemini-4-hydrogen', { config: { serviceTier: 'flex' } }),
      CTX,
    )
    const timeouts = client.calls.map(
      (c) =>
        (c as { config: { httpOptions?: { timeout?: number } } }).config.httpOptions
          ?.timeout,
    )
    expect(timeouts).toEqual([FLEX_DEFAULT_TIMEOUT_MS, GEMINI_4_DEFAULT_TIMEOUT_MS])
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      `${GEMINI_4_DEFAULT_TIMEOUT_MS} ms client-side ceiling`,
    )
  })

  it('the untiered ceiling fires at 20 minutes on the engine scheduler', async () => {
    const clock = new FakeClock()
    const hanging: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          return new Promise<GeminiResponseShape>((_resolve, reject) => {
            const signal = params.config?.abortSignal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
        countTokens: () => Promise.resolve({ totalTokens: 0 }),
      },
    }
    const settled = geminiAdapter({ client: hanging })
      .run(request('gemini-4-carbon'), { ...CTX, scheduler: clock })
      .catch((e: unknown) => e)
    await clock.advanceAsync(GEMINI_4_DEFAULT_TIMEOUT_MS - 1)
    expect(clock.pendingTimers).toBe(1)
    await clock.advanceAsync(1)
    const err = (await settled) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('timeout')
    expect(err.message).toContain(`${GEMINI_4_DEFAULT_TIMEOUT_MS}ms`)
  })
})

describe('pricing (snapshot gemini-2026-11-20)', () => {
  const pricing = geminiPricingSource()
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 100_000,
    details: {},
    raw: null,
  }

  it.each([
    // 800k input + 200k cached + 100k output, µUSD per M.
    [
      'gemini-4-carbon',
      'standard',
      800_000 * 4 + 200_000 * 0.2 + 100_000 * 20,
      'estimated',
    ],
    ['gemini-4-carbon', 'flex', 800_000 * 2 + 200_000 * 0.1 + 100_000 * 10, 'estimated'],
    [
      'gemini-4-argon',
      'standard',
      800_000 * 4 + 200_000 * 0.2 + 100_000 * 20,
      'estimated',
    ],
    ['gemini-4-argon', 'flex', 800_000 * 2 + 200_000 * 0.1 + 100_000 * 10, 'estimated'],
    ['gemini-4-neon', 'standard', 800_000 * 3 + 200_000 * 0.15 + 100_000 * 15, 'exact'],
    ['gemini-4-neon', 'flex', 800_000 * 1.5 + 200_000 * 0.075 + 100_000 * 7.5, 'exact'],
    [
      'gemini-4-hydrogen',
      'standard',
      800_000 * 1.5 + 200_000 * 0.075 + 100_000 * 7.5,
      'exact',
    ],
    [
      'gemini-4-hydrogen',
      'flex',
      800_000 * 0.75 + 200_000 * 0.0375 + 100_000 * 3.75,
      'exact',
    ],
  ] as const)('%s %s: %d µUSD, %s', (model, tier, microUsd, confidence) => {
    const cost = pricing.price(model, usage, tier)
    expect(cost.microUsd).toBe(microUsd)
    expect(cost.confidence).toBe(confidence)
    expect(cost.pricingVersion).toBe('gemini-2026-11-20')
    expect(cost.unpricedReason).toBeUndefined()
  })

  const client = () => {
    const sink = new RecordingSink()
    return {
      sink,
      make: (fake: ReturnType<typeof makeFakeGemini>) =>
        createClient({
          adapters: [geminiAdapter({ client: fake })],
          modelRegistry: defaultGeminiRegistry,
          pricingSources: { google: pricing },
          sink,
          clock: new FakeClock(),
          ids: new FakeIds(),
        }),
    }
  }

  it.each(MEDIUM_DEFAULT)(
    '%s: a successful call is estimated and its row carries the reason',
    async (model) => {
      const { sink, make } = client()
      const result = await make(
        makeFakeGemini(
          fakeGeminiResponse({
            text: 'ok',
            promptTokenCount: 1000,
            candidatesTokenCount: 10,
          }),
        ),
      ).generate({ provider: 'google', model, messages: [USER] }, { auth: AUTH })
      expect(result.cost?.confidence).toBe('estimated')
      expect(result.cost?.microUsd).toBe(1000 * 4 + 10 * 20)
      const reason = result.warnings.map((w) => w.message).join('\n')
      expect(reason).toContain('2026-12-01')
      expect(reason).toContain('2026-11-30')
      expect(JSON.stringify(sink.records[0]!.warnings)).toContain('2026-12-01')
      expect(sink.records[0]!.costConfidence).toBe('estimated')
    },
  )

  it('Carbon: a billed failure carries the reason on its row too', async () => {
    const { sink, make } = client()
    const err = await rejectionOf(
      make(
        makeFakeGemini({
          candidates: [],
          usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 50 },
        }),
      ).generate(
        { provider: 'google', model: 'gemini-4-carbon', messages: [USER] },
        { auth: AUTH },
      ),
    )
    expect(err.kind).toBe('server')
    const row = sink.records[0]!
    expect(row.status).not.toBe('ok')
    expect(row.costConfidence).toBe('estimated')
    expect(JSON.stringify(row.warnings)).toContain('2026-12-01')
  })

  it.each(HIGH_DEFAULT)(
    '%s: a plain call is exact and has no pricing warning',
    async (model) => {
      const { make } = client()
      const result = await make(
        makeFakeGemini(
          fakeGeminiResponse({
            text: 'ok',
            promptTokenCount: 1000,
            candidatesTokenCount: 10,
          }),
        ),
      ).generate({ provider: 'google', model, messages: [USER] }, { auth: AUTH })
      expect(result.cost?.confidence).toBe('exact')
      expect(result.warnings).toEqual([])
    },
  )

  it.each(HIGH_DEFAULT)(
    '%s: grounding is $14 per 1,000 queries, estimated even with zero queries, with the overhead warning',
    async (model) => {
      const grounded = (queries: string[]) =>
        client()
          .make(
            makeFakeGemini(
              fakeGeminiResponse({
                text: 'answer',
                promptTokenCount: 1000,
                candidatesTokenCount: 10,
                groundingMetadata: { webSearchQueries: queries },
              }),
            ),
          )
          .generate(
            {
              provider: 'google',
              model,
              messages: [USER],
              config: {
                providerOptions: { google: { tools: [{ googleSearch: {} }] } },
              } as never,
            },
            { auth: AUTH },
          )
      const two = await grounded(['a', 'b'])
      expect(two.cost?.details.tools).toBe(28_000)
      expect(two.cost?.confidence).toBe('estimated')
      const zero = await grounded([])
      expect(zero.cost?.details.tools).toBe(0)
      expect(zero.cost?.confidence).toBe('estimated')
      for (const result of [two, zero]) {
        expect(result.warnings.map((w) => w.message).join('\n')).toContain(
          "bills grounding's internal tool instructions",
        )
      }
    },
  )

  it('a Gemini 3 call that requested Search and ran no query stays exact', () => {
    const cost = pricing.price('gemini-3.8-flash', {
      inputTokens: 1000,
      outputTokens: 10,
      details: { web_search_requested: 1, web_search_calls: 0 },
      raw: null,
    })
    expect(cost.confidence).toBe('exact')
  })
})
