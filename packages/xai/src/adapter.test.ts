/**
 * @gullabs/xai — adapter contract tests.
 *
 * All tests use fakes from @gullabs/testing — NO real network calls.
 * makeFakeXai/fakeXaiResponse are the sole test doubles.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import {
  LlmError,
  createClient,
  createModelRegistry,
  retryMiddleware,
} from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx, ModelDescriptor } from '@gullabs/core'
import { XAI_DEFAULT_TIMEOUT_MS, XAI_TIMEOUT_BUFFER_MS } from './client.js'
import type { XaiClientLike, XaiRequestOptions, XaiTransport } from './client.js'
import {
  FakeClock,
  FakeIds,
  fakeXaiResponse,
  makeFakeXai,
  RecordingSink,
} from '@gullabs/testing'
import { xaiAdapter, classifyXaiError } from './adapter.js'
import { computeXaiCost, xaiPricingSource } from './pricing.js'
import {
  xaiRegistry,
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  grok47ModelDescriptor,
} from './models.js'
import { makeTestDescriptor } from '../../core/src/test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    ...overrides,
  }
}

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeXaiDescriptor(
  overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'model'>,
): ModelDescriptor {
  return makeTestDescriptor({
    provider: 'xai',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 0. Provider guard
// ---------------------------------------------------------------------------

describe('provider guard', () => {
  it('throws bad_request when req.provider !== "xai"', async () => {
    const adapter = xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'hi' })) })
    await expect(
      adapter.run(makeResolvedReq({ provider: 'google' }), FAKE_CTX),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

// ---------------------------------------------------------------------------
// 1. Basic text completion + messages/system mapping
// ---------------------------------------------------------------------------

describe('basic text completion', () => {
  it('maps a single user message and system instruction, extracts text + usage', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({
        text: 'Hi there',
        reasoningText: 'thinking about it',
        inputTokens: 208,
        cachedTokens: 128,
        outputTokens: 42,
        reasoningTokens: 33,
        totalTokens: 250,
        status: 'completed',
      }),
    )
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq({ system: 'Be nice.' }), FAKE_CTX)

    expect(result.text).toBe('Hi there')
    expect(result.reasoningText).toBe('thinking about it')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.inputTokens).toBe(208)
    expect(result.usage.outputTokens).toBe(42)
    expect(result.usage.cachedInputTokens).toBe(128)
    expect(result.usage.thinkingTokens).toBe(33)
    expect(result.usage.totalTokens).toBe(250)
    expect(result.usage.details).toMatchObject({
      input: 208,
      output: 42,
      cached: 128,
      thinking: 33,
    })
    expect(result.usage.raw).toMatchObject({ input_tokens: 208 })

    const call = client.calls[0] as {
      instructions?: string
      input: unknown[]
      store: boolean
    }
    expect(call.instructions).toBe('Be nice.')
    expect(call.store).toBe(false)
    expect(call.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    ])
  })

  it('surfaces numeric tool-usage extras (e.g. attachment_search) into usage.details', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({
        text: 'based on the doc',
        inputTokens: 100,
        outputTokens: 20,
        usageExtras: {
          num_server_side_tools_used: 3,
          num_sources_used: 2,
        },
      }),
    )
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'summarize' },
              { kind: 'file-ref', fileId: 'file_abc' },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.num_server_side_tools_used).toBe(3)
    expect(result.usage.details.num_sources_used).toBe(2)
    expect(result.usage.details.server_tools_requested).toBe(1)
    expect(result.usage.details.attachment_search_unpinned).toBe(1)
    expect(result.warnings.some((w) => w.message.includes('attachment_search'))).toBe(
      true,
    )
    expect(result.usage.raw).toMatchObject({
      num_server_side_tools_used: 3,
      num_sources_used: 2,
    })
  })

  it('forwards temperature and topP to temperature/top_p', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({ config: { temperature: 0.3, topP: 0.9 } }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { temperature?: number; top_p?: number }
    expect(call.temperature).toBe(0.3)
    expect(call.top_p).toBe(0.9)
  })

  it('maps multi-turn messages with correct role mapping', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hi' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hello!' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'How are you?' }] },
        ],
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { input: { role: string }[] }
    expect(call.input.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('emits llm.adapter.dispatch debug log before SDK call', async () => {
    const debugFn = vi.fn()
    const ctx: AdapterCtx = {
      auth: { apiKey: 'test-key' },
      logger: { info() {}, warn() {}, error() {}, debug: debugFn },
    }
    const client = makeFakeXai(fakeXaiResponse({ text: 'hi' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(makeResolvedReq(), ctx)

    expect(debugFn).toHaveBeenCalledOnce()
    const [obj, msg] = debugFn.mock.calls[0]!
    expect(msg).toBe('llm.adapter.dispatch')
    expect(obj).toMatchObject({ model: 'grok-4.5' })
  })

  it('uses a _clientFactory override when supplied', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'factory-built' }))
    const factory = vi.fn().mockResolvedValue(client)
    const adapter = xaiAdapter({ _clientFactory: factory })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(factory).toHaveBeenCalledWith(FAKE_CTX.auth, undefined)
    expect(result.text).toBe('factory-built')
  })

  it('forwards ctx.signal to responses.create', async () => {
    const controller = new AbortController()
    let receivedOptions: { signal?: AbortSignal } | undefined
    const client = {
      responses: {
        async create(_params: unknown, options?: { signal?: AbortSignal }) {
          receivedOptions = options
          return fakeXaiResponse({ text: 'ok' })
        },
      },
    }
    const adapter = xaiAdapter({ client })
    await adapter.run(makeResolvedReq(), { ...FAKE_CTX, signal: controller.signal })

    expect(receivedOptions?.signal).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// 2. Reasoning effort mapping
// ---------------------------------------------------------------------------

describe('reasoning effort mapping', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'rejects reasoning.effort=%s when no descriptor is attached (fail-closed)',
    async (effort) => {
      const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
      const adapter = xaiAdapter({ client })
      await expect(
        adapter.run(makeResolvedReq({ config: { reasoning: { effort } } }), FAKE_CTX),
      ).rejects.toMatchObject({ kind: 'bad_request' })
    },
  )

  it('rejects reasoning.effort=none with bad_request even without a modelDescriptor', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({ config: { reasoning: { effort: 'none' } } }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('forwards grok-4.6 admitted efforts including xhigh', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    const descriptor = makeXaiDescriptor({
      model: 'grok-4.6',
      capabilities: { admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    })
    await adapter.run(
      makeResolvedReq({
        model: 'grok-4.6',
        config: { reasoning: { effort: 'xhigh' } },
        modelDescriptor: descriptor,
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { reasoning?: { effort: string } }
    expect(call.reasoning).toEqual({ effort: 'xhigh' })
  })

  it('rejects an effort not in modelDescriptor.capabilities.admittedReasoningEfforts', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    const descriptor = makeXaiDescriptor({
      model: 'grok-4.5',
      capabilities: { admittedReasoningEfforts: ['high'] },
    })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: { reasoning: { effort: 'low' } },
          modelDescriptor: descriptor,
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects reasoning.budgetTokens with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({ config: { reasoning: { budgetTokens: 1000 } } }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('does not throw on reasoning.includeThoughts (no-op) and still surfaces reasoningText', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({ text: 'ok', reasoningText: 'reasoning summary' }),
    )
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        config: { reasoning: { effort: 'low', includeThoughts: false } },
        modelDescriptor: makeXaiDescriptor({
          model: 'grok-4.5',
          capabilities: { admittedReasoningEfforts: ['low', 'high'] },
        }),
      }),
      FAKE_CTX,
    )
    expect(result.reasoningText).toBe('reasoning summary')
  })
})

// ---------------------------------------------------------------------------
// 3. Structured output
// ---------------------------------------------------------------------------

describe('structured output', () => {
  it('rejects built-in search with structured output without descriptor admission', async () => {
    const client = makeFakeXai(fakeXaiResponse({ structuredJson: '{}' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({
          modelDescriptor: {
            ...grok45ModelDescriptor,
            capabilities: {
              ...grok45ModelDescriptor.capabilities,
              structuredOutputWithTools: false,
            },
          },
          outputJsonSchema: { type: 'object' },
          config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it.each([grok45ModelDescriptor, grok46ModelDescriptor, grok47ModelDescriptor])(
    'admits built-in search with structured output on $model',
    async (modelDescriptor) => {
      const client = makeFakeXai(fakeXaiResponse({ structuredJson: '{"a":1}' }))
      const result = await xaiAdapter({ client }).run(
        makeResolvedReq({
          model: modelDescriptor.model,
          modelDescriptor,
          outputJsonSchema: { type: 'object' },
          config: {
            providerOptions: {
              xai: { tools: [{ type: 'web_search' }], toolChoice: 'required' },
            },
          },
        }),
        FAKE_CTX,
      )
      expect(result.rawStructured).toEqual({ a: 1 })
      const call = client.calls[0] as { tool_choice?: unknown; text?: unknown }
      expect(call.tool_choice).toBe('required')
      expect(call.text).toMatchObject({ format: { type: 'json_schema', strict: true } })
    },
  )

  it('sends text.format.type==="json_schema" (not response_format) and parses rawStructured', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({ structuredJson: '{"name":"Bob","age":30}' }),
    )
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      text?: { format: { type: string } }
      response_format?: unknown
    }
    expect(call.text?.format.type).toBe('json_schema')
    expect(call.response_format).toBeUndefined()
    expect(result.rawStructured).toEqual({ name: 'Bob', age: 30 })
  })

  it('derives the schema name from outputJsonSchema.title when present', async () => {
    const client = makeFakeXai(fakeXaiResponse({ structuredJson: '{"name":"Bob"}' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        outputJsonSchema: {
          title: 'Person',
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { text?: { format: { name: string } } }
    expect(call.text?.format.name).toBe('Person')
  })

  it('falls back to "structured_output" as the schema name when no title is present', async () => {
    const client = makeFakeXai(fakeXaiResponse({ structuredJson: '{"name":"Bob"}' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { text?: { format: { name: string } } }
    expect(call.text?.format.name).toBe('structured_output')
  })

  it('leaves rawStructured undefined (no throw) when text is not valid JSON', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'not json' }))
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: { type: 'object' } }),
      FAKE_CTX,
    )
    expect(result.rawStructured).toBeUndefined()
    expect(result.text).toBe('not json')
  })
})

// ---------------------------------------------------------------------------
// 3b. Multiple `type: 'message'` output items (last-item rule)
// ---------------------------------------------------------------------------

describe('multiple message output items', () => {
  it('single-message responses are unaffected: no warning, text unchanged', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'Hi there' }))
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('Hi there')
    expect(result.warnings).toEqual([])
  })

  it('joins multiple output_text parts WITHIN a single message item (segmentation, not duplication)', async () => {
    const client = makeFakeXai({
      id: 'resp-1',
      model: 'grok-4.5',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Hello, ' },
            { type: 'output_text', text: 'world.' },
          ],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('Hello, world.')
    expect(result.warnings).toEqual([])
  })

  it('takes the LAST message item as text when multiple message items are present, and emits a warning naming the dropped count', async () => {
    const client = makeFakeXai({
      id: 'resp-2',
      model: 'grok-4.5',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"a":1}' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"a":2}' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('{"a":2}')
    expect(result.warnings).toEqual([
      {
        type: 'other',
        message:
          'xai: response contained 2 message output items; using the last one and discarding 1 earlier message item(s).',
      },
    ])
  })

  it('reasoningText assembly from reasoning items is unaffected by the multi-message rule', async () => {
    const client = makeFakeXai({
      id: 'resp-3',
      model: 'grok-4.5',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking...' }],
          status: 'completed',
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'draft' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'final' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.reasoningText).toBe('thinking...')
    expect(result.text).toBe('final')
  })
})

// ---------------------------------------------------------------------------
// 4. max_output_tokens + finishReason
// ---------------------------------------------------------------------------

describe('max_output_tokens and finishReason', () => {
  it('forwards max_output_tokens verbatim, including very large values', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({ config: { maxOutputTokens: 100_000_000 } }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { max_output_tokens?: number }
    expect(call.max_output_tokens).toBe(100_000_000)
  })

  it('maps status:"incomplete" + reason:"max_output_tokens" to finishReason:"length" (not thrown)', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({
        text: 'truncated',
        status: 'incomplete',
        incompleteReason: 'max_output_tokens',
      }),
    )
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.finishReason).toBe('length')
    expect(result.text).toBe('truncated')
  })

  it('maps status:"completed" to finishReason:"stop"', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok', status: 'completed' }))
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.finishReason).toBe('stop')
  })

  it('maps an unrecognized status to finishReason:"other"', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok', status: 'queued' }))
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.finishReason).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// 5. Vision / media mapping
// ---------------------------------------------------------------------------

describe('vision / media mapping', () => {
  it('maps a valid inline jpeg to an input_image data URL', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'what is this' },
              { kind: 'inline-media', mimeType: 'image/jpeg', data: 'ZmFrZQ==' },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as {
      input: { content: { type: string; image_url?: string }[] }[]
    }
    expect(call.input[0]?.content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,ZmFrZQ==',
    })
  })

  it('maps a valid inline png the same way', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'ZmFrZQ==' }],
          },
        ],
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { input: { content: { image_url?: string }[] }[] }
    expect(call.input[0]?.content[0]?.image_url).toBe('data:image/png;base64,ZmFrZQ==')
  })

  it('rejects a non-image inline mimeType with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                { kind: 'inline-media', mimeType: 'application/pdf', data: 'ZmFrZQ==' },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects an oversize (>20MiB) inline image with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    // 21 MiB of raw bytes, base64-encoded (~28MB string) — well over the 20MiB ceiling.
    const bigBuffer = Buffer.alloc(21 * 1024 * 1024, 1)
    const bigBase64 = bigBuffer.toString('base64')
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'inline-media', mimeType: 'image/png', data: bigBase64 }],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('maps a FileUriPart with an https:// URL and image mimeType', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'file-uri',
                uri: 'https://example.com/photo.png',
                mimeType: 'image/png',
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { input: { content: { image_url?: string }[] }[] }
    expect(call.input[0]?.content[0]?.image_url).toBe('https://example.com/photo.png')
  })

  it('rejects a FileUriPart with a non-http(s) scheme', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                { kind: 'file-uri', uri: 'gs://bucket/photo.png', mimeType: 'image/png' },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects a FileUriPart with a non-image mimeType', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  uri: 'https://example.com/doc.pdf',
                  mimeType: 'application/pdf',
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects a Gemini Files host even with https image mimeType', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                  mimeType: 'image/png',
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('maps FileRefPart to input_file.file_id', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'summarize' },
              {
                kind: 'file-ref',
                fileId: 'file_a128090d-f0c9-4873-bd84-e499777e7417',
                mimeType: 'application/pdf',
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as {
      input: { content: { type?: string; file_id?: string; text?: string }[] }[]
    }
    expect(call.input[0]?.content).toEqual([
      { type: 'input_text', text: 'summarize' },
      {
        type: 'input_file',
        file_id: 'file_a128090d-f0c9-4873-bd84-e499777e7417',
      },
    ])
  })

  it('rejects empty FileRefPart.fileId', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'file-ref', fileId: '   ' }],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

// ---------------------------------------------------------------------------
// 6. providerOptions.xai
// ---------------------------------------------------------------------------

describe('providerOptions.xai', () => {
  it('forwards promptCacheKey to prompt_cache_key', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        config: { providerOptions: { xai: { promptCacheKey: 'my-cache-key' } } },
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { prompt_cache_key?: string }
    expect(call.prompt_cache_key).toBe('my-cache-key')
  })

  it('rejects an unknown key under providerOptions.xai with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            providerOptions: {
              xai: { promptCacheKey: 'ok', bogus: true } as unknown as {
                promptCacheKey?: string
              },
            },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects an empty-string promptCacheKey with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: { providerOptions: { xai: { promptCacheKey: '' } } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects a non-object providerOptions.xai with bad_request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            providerOptions: { xai: 'nope' as unknown as { promptCacheKey?: string } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

// ---------------------------------------------------------------------------
// 7. serviceTier rejection
// ---------------------------------------------------------------------------

describe('serviceTier', () => {
  it('rejects an explicit serviceTier when the descriptor admits none', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('forwards serviceTier=priority on grok-4.6 and echoes servedServiceTier', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok', serviceTier: 'priority' }))
    const adapter = xaiAdapter({ client })
    const descriptor = makeXaiDescriptor({
      model: 'grok-4.6',
      capabilities: { serviceTiers: ['priority'] },
    })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.6',
        config: { serviceTier: 'priority' },
        modelDescriptor: descriptor,
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { service_tier?: string }
    expect(call.service_tier).toBe('priority')
    expect(result.servedServiceTier).toBe('priority')
  })

  it('surfaces a default-served priority request as servedServiceTier=default', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok', serviceTier: 'default' }))
    const adapter = xaiAdapter({ client })
    const descriptor = makeXaiDescriptor({
      model: 'grok-4.6',
      capabilities: { serviceTiers: ['priority'] },
    })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.6',
        config: { serviceTier: 'priority' },
        modelDescriptor: descriptor,
      }),
      FAKE_CTX,
    )
    expect(result.servedServiceTier).toBe('default')
  })

  it('rejects serviceTier=flex on grok-4.6 even though xAI would remap it', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    const descriptor = makeXaiDescriptor({
      model: 'grok-4.6',
      capabilities: { serviceTiers: ['priority'] },
    })
    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'grok-4.6',
          config: { serviceTier: 'flex' },
          modelDescriptor: descriptor,
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

// ---------------------------------------------------------------------------
// 8. Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('classifies a 400 API-key-shaped error as invalid_auth', async () => {
    const client = makeFakeXai(() => {
      throw {
        status: 400,
        code: 'invalid-argument',
        error:
          'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
      }
    })
    const adapter = xaiAdapter({ client })
    let thrown: unknown
    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
    expect((thrown as LlmError).provider).toBe('xai')
  })

  it('classifies a 400 model-not-found error as bad_request (NOT invalid_auth)', async () => {
    const client = makeFakeXai(() => {
      throw { status: 400, code: 'invalid-argument', error: 'Model not found: grok-99' }
    })
    const adapter = xaiAdapter({ client })
    let thrown: unknown
    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('bad_request')
    expect((thrown as LlmError).provider).toBe('xai')
  })

  it('classifies a 422 malformed-body error as bad_request', async () => {
    const client = makeFakeXai(() => {
      throw {
        status: 422,
        error: 'Failed to deserialize the JSON body into the target type: ...',
      }
    })
    const adapter = xaiAdapter({ client })
    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'bad_request',
    })
  })

  it('classifies a 429 as rate_limited', async () => {
    const client = makeFakeXai(() => {
      throw { status: 429 }
    })
    const adapter = xaiAdapter({ client })
    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'rate_limited',
    })
  })

  it('classifies a 500 as server', async () => {
    const client = makeFakeXai(() => {
      throw { status: 500 }
    })
    const adapter = xaiAdapter({ client })
    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
    })
  })

  it('classifies a recorded safety-check 403 string body as content_filter', async () => {
    const client = makeFakeXai(() => {
      throw {
        status: 403,
        error: 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
      }
    })
    const adapter = xaiAdapter({ client })
    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({
      kind: 'content_filter',
      retryable: false,
      httpStatus: 403,
      provider: 'xai',
    })
  })

  it('classifyXaiError passes an already-classified LlmError through unchanged', () => {
    const original = new LlmError('boom', { kind: 'timeout', retryable: true })
    expect(classifyXaiError(original)).toBe(original)
  })

  it('classifyXaiError does not misclassify a 401 (already invalid_auth via classifyHttpStatus)', () => {
    const result = classifyXaiError({ status: 401 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.provider).toBe('xai')
  })

  it('detects the auth signature when obj.error is the body error string (openai SDK shape)', () => {
    // openai's APIError hoists the body's `error` field onto `.error` — for
    // xAI's `{ code, error }` bodies that is the message string itself.
    const result = classifyXaiError({
      status: 400,
      error:
        'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
    })
    expect(result.kind).toBe('invalid_auth')
  })

  it('detects the auth signature when obj.error is the full parsed body object (fixture shape)', () => {
    const result = classifyXaiError({
      status: 400,
      error: {
        code: 'invalid-argument',
        error:
          'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
      },
    })
    expect(result.kind).toBe('invalid_auth')
  })

  it('never scans free-form Error.message — a 400 whose message merely mentions the key stays bad_request', () => {
    const result = classifyXaiError({ status: 400, message: 'Incorrect API Key' })
    expect(result.kind).toBe('bad_request')
  })

  it('a 400 whose structured body echoes "api key" in a non-auth context stays bad_request', () => {
    // e.g. schema validation echoing user content that happens to talk about
    // API keys — must NOT be reclassified as invalid_auth.
    const result = classifyXaiError({
      status: 400,
      error: {
        code: 'invalid-argument',
        error:
          "Invalid request content: Schema validation failed: /properties/api key/enum: value 'my api key' not permitted",
      },
    })
    expect(result.kind).toBe('bad_request')
  })

  it('a 400 with a non-signature auth-adjacent body text stays bad_request', () => {
    const result = classifyXaiError({
      status: 400,
      error: { message: 'invalid api key' },
    })
    expect(result.kind).toBe('bad_request')
  })

  it('classifies a 403 whose structured .error starts with the safety prefix as content_filter', () => {
    const result = classifyXaiError({
      status: 403,
      error: 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    })
    expect(result.kind).toBe('content_filter')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.provider).toBe('xai')
    expect(result.message).toBe(
      'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    )
  })

  it('classifies an Error subclass with .status and structured .error (SDK shape) as content_filter', () => {
    class PermissionDeniedError extends Error {
      status = 403
      error = 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER'
      constructor() {
        super(
          '403 "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER"',
        )
        this.name = 'PermissionDeniedError'
      }
    }
    const result = classifyXaiError(new PermissionDeniedError())
    expect(result.kind).toBe('content_filter')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.provider).toBe('xai')
    expect(result.message).toBe(
      'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    )
  })

  it('a bare 403 with no structured body stays invalid_auth', () => {
    const result = classifyXaiError({ status: 403 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.provider).toBe('xai')
  })

  it('a 403 whose structured body is a non-safety permission text stays invalid_auth', () => {
    const result = classifyXaiError({ status: 403, error: 'Permission denied' })
    expect(result.kind).toBe('invalid_auth')
    expect(result.httpStatus).toBe(403)
  })

  it('never scans free-form Error.message for the safety prefix — stays invalid_auth', () => {
    const err = new Error(
      'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    ) as Error & { status: number }
    err.status = 403
    const result = classifyXaiError(err)
    expect(result.kind).toBe('invalid_auth')
    expect(result.httpStatus).toBe(403)
  })
})

describe('transport-failure classification', () => {
  it('classifies the openai SDK APIConnectionError message as retryable server, not unknown', () => {
    class APIConnectionError extends Error {
      constructor() {
        super('Connection error.')
      }
    }
    const result = classifyXaiError(new APIConnectionError())
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('xai')
  })

  it('classifies the SDK deadline (APIConnectionTimeoutError) as a non-retryable transport timeout', () => {
    // A retry reaches the same SDK deadline and repeats the spend.
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {
      constructor() {
        super('Request timed out.')
      }
    }
    const result = classifyXaiError(new APIConnectionTimeoutError(), {
      timeoutMs: 125_000,
      elapsedMs: 125_001,
    })
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(false)
    expect(result.reason).toBe('transport_timeout')
    expect(result.provider).toBe('xai')
  })

  it('does not take an APIConnectionTimeoutError for the SDK deadline without the deadline context, or before the deadline could have fired', () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {
      constructor() {
        super('Request timed out.')
      }
    }
    const without = classifyXaiError(new APIConnectionTimeoutError())
    expect(without.reason).toBeUndefined()
    expect(without.retryable).toBe(true)

    const early = classifyXaiError(new APIConnectionTimeoutError(), {
      timeoutMs: 125_000,
      elapsedMs: 40,
    })
    expect(early.reason).toBeUndefined()
    expect(early.retryable).toBe(true)
  })

  it.each([
    [
      'OS ETIMEDOUT',
      Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    ],
    ['TLS handshake timeout', new Error('TLS handshake timed out')],
  ])(
    'a wrapped %s is not the SDK deadline even when it ran as long as the deadline',
    (_name, cause) => {
      class APIConnectionTimeoutError extends Error {
        constructor(c: Error) {
          super('Request timed out.')
          this.cause = c
        }
      }
      const result = classifyXaiError(
        new APIConnectionTimeoutError(new TypeError('fetch failed', { cause })),
        { timeoutMs: 1_000, elapsedMs: 5_000 },
      )
      expect(result.reason).toBeUndefined()
      expect(result.retryable).toBe(true)
    },
  )

  it('an SDK-wrapped AbortError that ran for the full deadline is the SDK deadline', () => {
    class APIConnectionTimeoutError extends Error {
      constructor(c: Error) {
        super('Request timed out.')
        this.cause = c
      }
    }
    const result = classifyXaiError(
      new APIConnectionTimeoutError(
        new DOMException('This operation was aborted', 'AbortError'),
      ),
      { timeoutMs: 1_000, elapsedMs: 1_002 },
    )
    expect(result).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
  })

  it('classifies APIConnectionTimeoutError by constructor name even with a non-timeout message', () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {
      constructor() {
        super('Connection error.')
      }
    }
    const result = classifyXaiError(new APIConnectionTimeoutError(), {
      timeoutMs: 1_000,
      elapsedMs: 1_000,
    })
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(false)
    expect(result.reason).toBe('transport_timeout')
  })

  it('keeps a connect timeout retryable: nothing was sent, so a retry is safe', () => {
    class APIConnectionTimeoutError extends Error {
      constructor(cause: Error) {
        super('Request timed out.')
        this.cause = cause
      }
    }
    const connect = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    const result = classifyXaiError(
      new APIConnectionTimeoutError(new TypeError('fetch failed', { cause: connect })),
    )
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('classifies a plain Error with "Connection error." message as retryable server', () => {
    const result = classifyXaiError(new Error('Connection error.'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'])(
    'classifies a Node errno %s (on .code) as retryable server',
    (code) => {
      const err = new Error(`read ${code}`) as Error & { code: string }
      err.code = code
      const result = classifyXaiError(err)
      expect(result.kind).toBe('server')
      expect(result.retryable).toBe(true)
    },
  )

  it('classifies "socket hang up" as retryable server', () => {
    const result = classifyXaiError(new Error('socket hang up'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it('classifies undici "fetch failed" as retryable server', () => {
    const result = classifyXaiError(new TypeError('fetch failed'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it('detects a transport failure wrapped as .cause (APIConnectionError shape)', () => {
    class APIConnectionError extends Error {
      constructor(cause: Error) {
        super('Connection error.')
        this.cause = cause
      }
    }
    const causeErr = new Error('connect ECONNREFUSED 127.0.0.1:443') as Error & {
      code: string
    }
    causeErr.code = 'ECONNREFUSED'
    const result = classifyXaiError(new APIConnectionError(causeErr))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it('does not reclassify errors that already have a real HTTP status', () => {
    const result = classifyXaiError({ status: 500, message: 'Connection error.' })
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    // Confirm this took the status-based path, not the transport fallback,
    // by checking httpStatus made it through.
    expect(result.httpStatus).toBe(500)
  })

  it('does not reclassify an unrelated unknown error as retryable', () => {
    const result = classifyXaiError(new Error('something totally unrelated broke'))
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('end-to-end: adapter.run surfaces a connection error as retryable server, not unknown', async () => {
    const client = makeFakeXai(() => {
      throw new Error('Connection error.')
    })
    const adapter = xaiAdapter({ client })
    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
      provider: 'xai',
    })
  })
})

// ---------------------------------------------------------------------------
// Transport and timeout (ADR-032)
// ---------------------------------------------------------------------------

function undiciError(name: string, code: string, message: string): Error {
  return Object.assign(new Error(message), { name, code })
}

/** A client that records the per-request options and returns a canned response. */
function makeOptionsCapturingClient(): {
  client: XaiClientLike
  optionCalls: Array<XaiRequestOptions | undefined>
} {
  const optionCalls: Array<XaiRequestOptions | undefined> = []
  const response = fakeXaiResponse({ text: 'ok' })
  const client: XaiClientLike = {
    responses: {
      create(_params, options) {
        optionCalls.push(options)
        return Promise.resolve(response as never)
      },
    },
  }
  return { client, optionCalls }
}

describe('xai SDK timeout derivation', () => {
  it('derives the SDK timeout from config.timeoutMs plus the buffer', async () => {
    const { client, optionCalls } = makeOptionsCapturingClient()
    await xaiAdapter({ client }).run(
      makeResolvedReq({ config: { timeoutMs: 120_000 } }),
      FAKE_CTX,
    )
    expect(XAI_TIMEOUT_BUFFER_MS).toBe(5_000)
    expect(optionCalls[0]?.timeout).toBe(125_000)
  })

  it('falls back to XAI_DEFAULT_TIMEOUT_MS (one hour) when timeoutMs is unset', async () => {
    const { client, optionCalls } = makeOptionsCapturingClient()
    await xaiAdapter({ client }).run(makeResolvedReq(), FAKE_CTX)
    expect(XAI_DEFAULT_TIMEOUT_MS).toBe(3_600_000)
    expect(optionCalls[0]?.timeout).toBe(3_600_000)
  })

  it('still forwards the abort signal next to the timeout', async () => {
    const { client, optionCalls } = makeOptionsCapturingClient()
    const controller = new AbortController()
    await xaiAdapter({ client }).run(makeResolvedReq(), {
      ...FAKE_CTX,
      signal: controller.signal,
    })
    expect(optionCalls[0]?.signal).toBe(controller.signal)
    expect(optionCalls[0]?.timeout).toBe(3_600_000)
  })
})

describe('xai transport option', () => {
  it('passes the transport to the client factory', async () => {
    const transport: XaiTransport = {
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch,
      fetchOptions: { keepalive: true },
    }
    const { client } = makeOptionsCapturingClient()
    const factory = vi.fn((_auth: unknown, _transport?: XaiTransport) => client)
    await xaiAdapter({ transport, _clientFactory: factory }).run(
      makeResolvedReq(),
      FAKE_CTX,
    )
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0]?.[0]).toEqual({ apiKey: 'test-key' })
    // A snapshot taken at construction: same fetch and options, not the host's object.
    expect(factory.mock.calls[0]?.[1]).toEqual(transport)
    expect(factory.mock.calls[0]?.[1]).not.toBe(transport)
  })

  it('passes undefined when no transport is configured', async () => {
    const { client } = makeOptionsCapturingClient()
    const factory = vi.fn((_auth: unknown, _transport?: XaiTransport) => client)
    await xaiAdapter({ _clientFactory: factory }).run(makeResolvedReq(), FAKE_CTX)
    expect(factory.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('rejects transport combined with an injected client', () => {
    const { client } = makeOptionsCapturingClient()
    const transport: XaiTransport = { fetch: (() => {}) as unknown as typeof fetch }
    expect(() => xaiAdapter({ client, transport })).toThrow(
      expect.objectContaining({ kind: 'bad_request' }) as never,
    )
  })

  it.each(['headers', 'signal', 'body', 'method'] as const)(
    'rejects transport.fetchOptions.%s, which the request owns',
    (key) => {
      const transport = {
        fetch: (() => {}) as unknown as typeof fetch,
        fetchOptions: { [key]: undefined },
      } as unknown as XaiTransport
      expect(() => xaiAdapter({ transport })).toThrow(
        expect.objectContaining({
          kind: 'bad_request',
          message: expect.stringContaining(`fetchOptions.${key}`) as never,
        }) as never,
      )
    },
  )

  it.each([
    ['fetchOptions: null', { fetch: (() => {}) as unknown, fetchOptions: null }],
    ['fetchOptions: an array', { fetch: (() => {}) as unknown, fetchOptions: [] }],
    ['fetchOptions: a string', { fetch: (() => {}) as unknown, fetchOptions: 'x' }],
    ['fetch missing', { fetchOptions: {} }],
    ['fetch not a function', { fetch: 'not-a-function' as unknown }],
  ])(
    'rejects a malformed transport (%s) with bad_request, not a TypeError',
    (_name, t) => {
      expect(() => xaiAdapter({ transport: t as unknown as XaiTransport })).toThrow(
        expect.objectContaining({ kind: 'bad_request', provider: 'xai' }) as never,
      )
    },
  )

  it('mutating the host transport object after construction cannot smuggle in a reserved option', async () => {
    const seen: Array<Record<string, unknown>> = []
    const stubFetch = ((_input: unknown, init: Record<string, unknown>) => {
      seen.push(init)
      return Promise.resolve(
        new Response(JSON.stringify(fakeXaiResponse({ text: 'ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch
    const transport = {
      fetch: stubFetch,
      fetchOptions: { keepalive: true } as Record<string, unknown>,
    }
    const adapter = xaiAdapter({ transport: transport as unknown as XaiTransport })
    transport.fetchOptions['headers'] = { 'x-smuggled': '1' }
    transport.fetchOptions['body'] = 'smuggled'
    transport.fetchOptions['keepalive'] = false

    await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(seen[0]?.['keepalive']).toBe(true)
    expect(seen[0]?.['body']).not.toBe('smuggled')
    expect(
      new Headers(seen[0]?.['headers'] as ConstructorParameters<typeof Headers>[0]).get(
        'x-smuggled',
      ),
    ).toBeNull()
  })

  it('reaches the real SDK: the stub fetch carries the request, the options and the timeout', async () => {
    const dispatcher = { sentinel: 'undici-agent' }
    const seen: Array<{ url: string; init: Record<string, unknown> }> = []
    const stubFetch = ((input: unknown, init: Record<string, unknown>) => {
      seen.push({ url: String(input), init })
      return Promise.resolve(
        new Response(JSON.stringify(fakeXaiResponse({ text: 'wire ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch
    const adapter = xaiAdapter({
      transport: {
        fetch: stubFetch,
        fetchOptions: { dispatcher } as unknown as XaiTransport['fetchOptions'] & object,
      },
    })

    const result = await adapter.run(
      makeResolvedReq({ config: { timeoutMs: 600_000 } }),
      FAKE_CTX,
    )

    expect(result.text).toBe('wire ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/responses')
    expect(seen[0]?.init['dispatcher']).toBe(dispatcher)
    expect(
      new Headers(
        seen[0]?.init['headers'] as ConstructorParameters<typeof Headers>[0],
      ).get('authorization'),
    ).toBe('Bearer test-key')
    expect(JSON.parse(String(seen[0]?.init['body']))).toMatchObject({
      model: 'grok-4.5',
      store: false,
    })
  })
})

describe('xai transport-timeout classification', () => {
  const headers = undiciError(
    'HeadersTimeoutError',
    'UND_ERR_HEADERS_TIMEOUT',
    'Headers Timeout Error',
  )
  const body = undiciError(
    'BodyTimeoutError',
    'UND_ERR_BODY_TIMEOUT',
    'Body Timeout Error',
  )

  it('classifies undici headers timeout under fetch failed as non-retryable with a reason', () => {
    const result = classifyXaiError(new TypeError('fetch failed', { cause: headers }))
    expect(result).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(result.message).toContain('headers')
  })

  it('classifies undici body timeout (terminated) as non-retryable with a reason', () => {
    const result = classifyXaiError(new TypeError('terminated', { cause: body }))
    expect(result).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(result.message).toContain('body')
  })

  it('finds the undici error through the SDK wrapper two levels deep', () => {
    class APIConnectionTimeoutError extends Error {
      constructor(cause: Error) {
        super('Request timed out. Node.js fetch timed out waiting for response headers')
        this.cause = cause
      }
    }
    const result = classifyXaiError(
      new APIConnectionTimeoutError(new TypeError('fetch failed', { cause: headers })),
    )
    expect(result).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
  })

  it('matches by class name when the code is absent', () => {
    const named = Object.assign(new Error('x'), { name: 'HeadersTimeoutError' })
    const result = classifyXaiError(new TypeError('fetch failed', { cause: named }))
    expect(result.reason).toBe('transport_timeout')
    expect(result.retryable).toBe(false)
  })

  it('survives a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    expect(classifyXaiError(a).kind).toBe('unknown')
  })

  it('a plain ETIMEDOUT stays a retryable server error (not a transport deadline)', () => {
    const err = Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const result = classifyXaiError(err)
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('end-to-end: a headers timeout is not retried and the ledger row carries the reason', async () => {
    const client = makeFakeXai(() => {
      throw new TypeError('fetch failed', { cause: headers })
    })
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      modelRegistry: xaiRegistry,
      sink,
      middleware: [
        retryMiddleware({ maxAttempts: 3 }, { sleep: () => Promise.resolve() }),
      ],
    })

    await expect(
      llm.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })

    expect(client.calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.errorKind).toBe('timeout')
    expect(sink.last()?.errorReason).toBe('transport_timeout')
  })

  it('control: a retryable connection error is retried by the same middleware', async () => {
    const client = makeFakeXai(() => {
      throw new Error('Connection error.')
    })
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      modelRegistry: xaiRegistry,
      sink: new RecordingSink(),
      middleware: [
        retryMiddleware({ maxAttempts: 3 }, { sleep: () => Promise.resolve() }),
      ],
    })
    await expect(
      llm.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(client.calls).toHaveLength(3)
  })
})

describe('adapter wires the SDK deadline into classification', () => {
  class APIConnectionTimeoutError extends Error {
    constructor(cause?: Error) {
      super('Request timed out.')
      if (cause !== undefined) this.cause = cause
    }
  }
  const abortError = () => new DOMException('This operation was aborted', 'AbortError')

  async function failWith(error: Error, advanceMs: number) {
    const real = performance.now.bind(performance)
    let offset = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + offset)
    try {
      const client = makeFakeXai(() => {
        offset += advanceMs
        throw error
      })
      return await xaiAdapter({ client })
        .run(makeResolvedReq({ config: { timeoutMs: 1_000 } }), FAKE_CTX)
        .then(
          () => undefined,
          (e: unknown) => e as LlmError,
        )
    } finally {
      spy.mockRestore()
    }
  }

  it('the SDK timer firing after the timeout the adapter set is non-retryable', async () => {
    const err = await failWith(new APIConnectionTimeoutError(abortError()), 6_000)
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
  })

  it('an abort that happened long before the SDK deadline (a host fetch with its own timeout) stays retryable', async () => {
    const err = await failWith(new APIConnectionTimeoutError(abortError()), 10)
    expect(err?.retryable).toBe(true)
    expect(err?.reason).toBeUndefined()
  })
})

describe('engine e2e: safety-check 403 ledger', () => {
  it('persists content_filter on the sink record', async () => {
    const client = makeFakeXai(() => {
      throw {
        status: 403,
        error: 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
      }
    })
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      modelRegistry: xaiRegistry,
      sink,
    })

    await expect(
      llm.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'content_filter' })

    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.status).toBe('content_filter')
    expect(sink.last()?.errorKind).toBe('content_filter')
  })
})

describe('xai function calling', () => {
  const tool = {
    name: 'get_temperature',
    description: 'Get temperature',
    inputJsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
  }

  it.each(['required', 'none'] as const)(
    'forwards string toolChoice %s',
    async (choice) => {
      const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
      const adapter = xaiAdapter({ client })
      await adapter.run(
        makeResolvedReq({
          modelDescriptor: grok45ModelDescriptor,
          tools: [tool],
          toolChoice: choice,
        }),
        FAKE_CTX,
      )
      expect((client.calls[0] as { tool_choice?: string }).tool_choice).toBe(choice)
    },
  )

  it('forwards string toolChoice auto', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        tools: [tool],
        toolChoice: 'auto',
      }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { tool_choice?: string }).tool_choice).toBe('auto')
  })

  it('maps function tools and flat tool_choice; collects function_call items', async () => {
    const client = makeFakeXai({
      id: 'resp-fn',
      model: 'grok-4.6',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'get_temperature',
          arguments: '{"location":"SF"}',
        } as never,
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.6',
        modelDescriptor: grok46ModelDescriptor,
        tools: [tool],
        toolChoice: { name: 'get_temperature' },
      }),
      FAKE_CTX,
    )
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call-1', toolName: 'get_temperature', args: { location: 'SF' } },
    ])
    const call = client.calls[0] as {
      tools: unknown
      tool_choice: unknown
    }
    expect(call.tools).toEqual([
      {
        type: 'function',
        name: 'get_temperature',
        description: 'Get temperature',
        parameters: tool.inputJsonSchema,
      },
    ])
    expect(call.tool_choice).toEqual({ type: 'function', name: 'get_temperature' })
  })

  it('rejects assistant history alongside grok-4.7 continuation state', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '59F' }))
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'grok-4.7',
          modelDescriptor: grok47ModelDescriptor,
          transientProviderState: {
            xai: {
              model: 'grok-4.7',
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'temp?' }] }],
            },
          },
          tools: [tool],
          messages: [
            { role: 'user', parts: [{ kind: 'text', text: 'temp?' }] },
            {
              role: 'assistant',
              parts: [
                {
                  kind: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'get_temperature',
                  args: { location: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'call-1',
                  toolName: 'get_temperature',
                  result: { temperature: 59 },
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })

  it('accepts text-only assistant examples in a fresh grok-4.7 request', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'Paris' }))
    await xaiAdapter({ client }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: '2+2?' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: '4' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'Capital of France?' }] },
        ],
      }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { input: unknown[] }).input).toHaveLength(3)
  })

  it('rejects grok-4.7 function-call history without encrypted replay state', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '59F' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({
          model: 'grok-4.7',
          modelDescriptor: grok47ModelDescriptor,
          messages: [
            { role: 'user', parts: [{ kind: 'text', text: 'temp?' }] },
            {
              role: 'assistant',
              parts: [
                {
                  kind: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'get_temperature',
                  args: { location: 'SF' },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'call-1',
                  toolName: 'get_temperature',
                  result: { temperature: 59 },
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })

  it('requires a descriptor for direct grok-4.7 calls', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await expect(
      xaiAdapter({ client }).run(makeResolvedReq({ model: 'grok-4.7' }), FAKE_CTX),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects a direct grok-4.7 descriptor that disables required replay', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({
          model: 'grok-4.7',
          modelDescriptor: makeXaiDescriptor({
            model: 'grok-4.7',
            capabilities: { continuation: 'history' },
          }),
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('keeps replayed file attachments in the estimated tool-cost lane', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'Summary' }))
    const result = await xaiAdapter({ client }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        transientProviderState: {
          xai: {
            model: 'grok-4.7',
            input: [
              { role: 'user', content: [{ type: 'input_file', file_id: 'file_abc' }] },
            ],
          },
        },
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Summarize it.' }] }],
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.attachment_search_unpinned).toBe(1)
    expect(computeXaiCost('grok-4.7', result.usage).confidence).toBe('estimated')
  })

  it('rejects an unknown tool result against replay state', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'Summary' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({
          model: 'grok-4.7',
          modelDescriptor: grok47ModelDescriptor,
          transientProviderState: {
            xai: {
              model: 'grok-4.7',
              input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
            },
          },
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'missing',
                  toolName: 'get_temperature',
                  result: 1,
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })

  it('replays tool-call and tool-result as store:false input items', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '59F' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        tools: [tool],
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'temp?' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'get_temperature',
                args: { location: 'SF' },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'get_temperature',
                result: { temperature: 59 },
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { input: unknown[]; store: boolean }
    expect(call.store).toBe(false)
    expect(call.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'temp?' }] },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'get_temperature',
        arguments: '{"location":"SF"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: '{"temperature":59}',
      },
    ])
  })

  it('keeps unparsable function_call arguments as the raw string', async () => {
    const client = makeFakeXai({
      id: 'resp-fn-bad',
      model: 'grok-4.5',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call-bad',
          name: 'get_temperature',
          arguments: 'not-json',
        } as never,
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        tools: [tool],
      }),
      FAKE_CTX,
    )
    expect(result.toolCalls?.[0]?.args).toBe('not-json')
  })

  it('combines server-side search tools with function tools', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        tools: [tool],
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      FAKE_CTX,
    )
    const tools = (client.calls[0] as { tools: Array<{ type: string }> }).tools
    expect(tools.map((t) => t.type)).toEqual(['web_search', 'function'])
  })

  it('skips function_call items without call_id or name', async () => {
    const client = makeFakeXai({
      id: 'resp-fn-empty',
      model: 'grok-4.5',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: '',
          name: 'get_temperature',
          arguments: '{}',
        } as never,
        { type: 'function_call', call_id: 'c1', name: '', arguments: '{}' } as never,
        {
          type: 'function_call',
          call_id: 'c2',
          name: 'get_temperature',
          arguments: 12,
        } as never,
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        tools: [tool],
      }),
      FAKE_CTX,
    )
    expect(result.toolCalls).toEqual([
      { toolCallId: 'c2', toolName: 'get_temperature', args: {} },
    ])
  })

  it('rejects an unknown search tool type at the adapter', async () => {
    const adapter = xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'ok' })) })
    await expect(
      adapter.run(
        makeResolvedReq({
          modelDescriptor: grok45ModelDescriptor,
          config: {
            providerOptions: { xai: { tools: [{ type: 'code_execution' }] as never } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects tools when functionCalling is not admitted', async () => {
    const adapter = xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'ok' })) })
    await expect(
      adapter.run(
        makeResolvedReq({
          tools: [tool],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('countTokens rejects tools', async () => {
    const adapter = xaiAdapter({
      _fetch: (async () => {
        throw new Error('should not fetch')
      }) as typeof fetch,
    })
    await expect(
      adapter.countTokens!(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          tools: [tool],
        },
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('xai Live Search tools', () => {
  it('maps all web_search and x_search optional wire fields', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: {
          providerOptions: {
            xai: {
              tools: [
                {
                  type: 'web_search',
                  excludedDomains: ['spam.example'],
                  enableImageUnderstanding: true,
                  enableImageSearch: true,
                },
                {
                  type: 'x_search',
                  excludedXHandles: ['spam'],
                  toDate: '2026-08-01',
                  enableImageUnderstanding: true,
                  enableVideoUnderstanding: true,
                },
              ],
            },
          },
        },
      }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { tools: unknown }).tools).toEqual([
      {
        type: 'web_search',
        excluded_domains: ['spam.example'],
        enable_image_understanding: true,
        enable_image_search: true,
      },
      {
        type: 'x_search',
        excluded_x_handles: ['spam'],
        to_date: '2026-08-01',
        enable_image_understanding: true,
        enable_video_understanding: true,
      },
    ])
  })

  it('emits snake_case tools wire shape and fails closed without grounding', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            providerOptions: { xai: { tools: [{ type: 'web_search' }] } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('grounding'),
    })

    const ok = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: {
          providerOptions: {
            xai: {
              tools: [
                { type: 'web_search', allowedDomains: ['docs.x.ai'] },
                { type: 'x_search', allowedXHandles: ['xai'], fromDate: '2026-01-01' },
              ],
            },
          },
        },
      }),
      FAKE_CTX,
    )
    expect(ok.text).toBe('ok')
    const call = client.calls[0] as { tools: unknown }
    expect(call.tools).toEqual([
      { type: 'web_search', allowed_domains: ['docs.x.ai'] },
      { type: 'x_search', allowed_x_handles: ['xai'], from_date: '2026-01-01' },
    ])
  })

  it('maps url_citation annotations to citations and flattens tool counters', async () => {
    const response = fakeXaiResponse({
      text: 'see docs',
      inputTokens: 10,
      outputTokens: 4,
      usageExtras: { num_server_side_tools_used: 1 },
    })
    response.usage['server_side_tool_usage_details'] = {
      web_search_calls: 1,
      x_search_calls: 0,
      document_search_calls: 0,
    }
    const message = response.output.find((item) => item.type === 'message') as {
      content: Array<{ annotations?: unknown[] }>
    }
    message.content[0]!.annotations = [
      { type: 'url_citation', url: 'https://docs.x.ai', title: '1' },
    ]
    const adapter = xaiAdapter({ client: makeFakeXai(response) })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.citations).toEqual([
      { url: 'https://docs.x.ai', title: '1', sourceName: 'docs.x.ai' },
    ])
    expect(result.usage.details.web_search_calls).toBe(1)
    expect(result.usage.details.server_tools_requested).toBe(1)
    expect(result.warnings).toEqual([])
  })

  it('expects x_posts_fetched and x_users_fetched when x_search is requested', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['server_side_tool_usage_details'] = {
      x_posts_fetched: 44,
      x_users_fetched: 3,
    }
    const adapter = xaiAdapter({ client: makeFakeXai(response) })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.x_search_requested).toBe(1)
    expect(result.usage.details.x_posts_fetched).toBe(44)
    expect(result.usage.details.x_users_fetched).toBe(3)
    expect(result.usage.details.server_tools_missing).toBeUndefined()
  })

  it('marks the call unpriced when an x_search item counter is absent', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['server_side_tool_usage_details'] = { x_posts_fetched: 1 }
    const adapter = xaiAdapter({ client: makeFakeXai(response) })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.server_tools_missing).toBe(1)
    expect(result.warnings[0]?.message).toContain('x_users_fetched')
    expect(result.warnings[0]?.message).toContain('unpriced')
  })

  it('warns when requested tool counters are missing', async () => {
    const adapter = xaiAdapter({
      client: makeFakeXai(
        fakeXaiResponse({ text: 'ok', inputTokens: 1, outputTokens: 1 }),
      ),
    })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.server_tools_requested).toBe(1)
    expect(result.warnings[0]?.message).toContain('web_search_calls')
  })

  it('maps top-level citations array and ignores earlier message annotations', async () => {
    const response = fakeXaiResponse({ text: 'final' })
    response.citations = [
      'https://first.example',
      { url: 'https://second.example', title: 'Second' },
    ]
    response.output = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'draft',
            annotations: [
              { type: 'url_citation', url: 'https://draft.example', title: 'Draft' },
            ],
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'final',
            annotations: [
              { type: 'url_citation', url: 'https://final.example', title: 'Final' },
            ],
          },
        ],
      },
    ]
    const adapter = xaiAdapter({ client: makeFakeXai(response) })
    const result = await adapter.run(
      makeResolvedReq({ modelDescriptor: grok45ModelDescriptor }),
      FAKE_CTX,
    )
    expect(result.citations?.map((c) => c.url)).toEqual([
      'https://first.example',
      'https://second.example',
      'https://final.example',
    ])
    expect(result.citations?.some((c) => c.url === 'https://draft.example')).toBe(false)
  })

  it('rejects non-boolean parallelToolCalls', async () => {
    const adapter = xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'ok' })) })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: { providerOptions: { xai: { parallelToolCalls: 'nope' as never } } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('forwards parallelToolCalls', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { parallelToolCalls: false } } },
      }),
      FAKE_CTX,
    )
    expect(
      (client.calls[0] as { parallel_tool_calls?: boolean }).parallel_tool_calls,
    ).toBe(false)
  })

  it('rejects unknown providerOptions.xai keys', async () => {
    const adapter = xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'ok' })) })
    await expect(
      adapter.run(
        makeResolvedReq({
          config: { providerOptions: { xai: { notAKey: true } as never } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('notAKey'),
    })
  })
})

// ---------------------------------------------------------------------------
// providerOptions.xai.toolChoice — server-side search tools only
// ---------------------------------------------------------------------------

describe('providerOptions.xai.toolChoice', () => {
  const functionTool = {
    name: 'get_temperature',
    description: 'Get the temperature for a city.',
    inputJsonSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  }

  async function runWithXaiOptions(
    xai: Record<string, unknown>,
    overrides: Partial<ResolvedRequest> = {},
  ) {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const run = xaiAdapter({ client }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: xai as never } },
        ...overrides,
      }),
      FAKE_CTX,
    )
    return { client, run }
  }

  it.each(['required', 'auto', 'none'] as const)(
    'forwards tool_choice "%s" with search tools and no function tools',
    async (toolChoice) => {
      const { client, run } = await runWithXaiOptions({
        tools: [{ type: 'web_search' }],
        toolChoice,
      })
      await run
      const call = client.calls[0] as { tool_choice?: unknown; tools?: unknown }
      expect(call.tool_choice).toBe(toolChoice)
      expect(call.tools).toEqual([{ type: 'web_search' }])
    },
  )

  it('sends no tool_choice when the option is absent', async () => {
    const { client, run } = await runWithXaiOptions({ tools: [{ type: 'web_search' }] })
    await run
    expect('tool_choice' in (client.calls[0] as object)).toBe(false)
  })

  it('rejects toolChoice without tools', async () => {
    const { client, run } = await runWithXaiOptions({ toolChoice: 'required' })
    await expect(run).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('requires a non-empty providerOptions.xai.tools'),
    })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects toolChoice with an empty tools array', async () => {
    const { client, run } = await runWithXaiOptions({ tools: [], toolChoice: 'required' })
    await expect(run).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('requires a non-empty providerOptions.xai.tools'),
    })
    expect(client.calls).toHaveLength(0)
  })

  it.each(['REQUIRED', 'any', true, { type: 'function', name: 'x' }])(
    'rejects the invalid toolChoice value %j',
    async (toolChoice) => {
      const { client, run } = await runWithXaiOptions({
        tools: [{ type: 'web_search' }],
        toolChoice,
      })
      await expect(run).rejects.toMatchObject({
        kind: 'bad_request',
        message: expect.stringContaining('must be "auto", "required" or "none"'),
      })
      expect(client.calls).toHaveLength(0)
    },
  )

  it('rejects toolChoice together with function tools', async () => {
    const { client, run } = await runWithXaiOptions(
      { tools: [{ type: 'web_search' }], toolChoice: 'required' },
      { tools: [functionTool] },
    )
    await expect(run).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('cannot be combined with function tools'),
    })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects toolChoice together with the request-level toolChoice', async () => {
    const { client, run } = await runWithXaiOptions(
      { tools: [{ type: 'web_search' }], toolChoice: 'required' },
      { tools: [functionTool], toolChoice: 'auto' },
    )
    await expect(run).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('cannot both be set'),
    })
    expect(client.calls).toHaveLength(0)
  })

  it('keeps the request-level toolChoice for mixed tools when the option is absent', async () => {
    const { client, run } = await runWithXaiOptions(
      { tools: [{ type: 'web_search' }] },
      { tools: [functionTool], toolChoice: 'required' },
    )
    await run
    const call = client.calls[0] as {
      tool_choice?: unknown
      tools: Array<{ type: string }>
    }
    expect(call.tool_choice).toBe('required')
    expect(call.tools.map((t) => t.type)).toEqual(['web_search', 'function'])
  })

  it.each(['required', 'none', 'auto'] as const)(
    'rejects toolChoice "%s" together with a file attachment',
    async (toolChoice) => {
      const { client, run } = await runWithXaiOptions(
        { tools: [{ type: 'web_search' }], toolChoice },
        {
          messages: [
            {
              role: 'user',
              parts: [
                { kind: 'text', text: 'summarise' },
                { kind: 'file-ref', fileId: 'file_123' },
              ],
            },
          ],
        },
      )
      await expect(run).rejects.toMatchObject({
        kind: 'bad_request',
        message: expect.stringContaining('cannot be combined with file attachments'),
      })
      expect(client.calls).toHaveLength(0)
    },
  )

  it('names the field when the config schema rejects a value', async () => {
    const llm = createClient({
      adapters: [xaiAdapter({ client: makeFakeXai(fakeXaiResponse({ text: 'ok' })) })],
      modelRegistry: xaiRegistry,
      sink: new RecordingSink(),
    })
    const generate = (xai: Record<string, unknown>) =>
      llm.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: { providerOptions: { xai: xai as never } },
        },
        { auth: { apiKey: 'test-key' } },
      )
    await expect(
      generate({ tools: [{ type: 'web_search' }], toolChoice: 'bad' }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('providerOptions.xai.toolChoice'),
    })
    await expect(
      generate({ tools: [{ type: 'web_search' }], maxTurns: 0 }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('providerOptions.xai.maxTurns'),
    })
    await expect(generate({ toolChoice: 'required' })).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('requires a non-empty providerOptions.xai.tools'),
    })
    await expect(generate({ maxTurns: 2 })).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('requires a non-empty providerOptions.xai.tools'),
    })
  })

  it('lists toolChoice in the unknown-key message', async () => {
    const { run } = await runWithXaiOptions({ notAKey: true })
    await expect(run).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining(
        'Allowed keys: promptCacheKey, tools, parallelToolCalls, toolChoice, maxTurns.',
      ),
    })
  })
})

// ---------------------------------------------------------------------------
// providerOptions.xai.maxTurns
// ---------------------------------------------------------------------------

describe('providerOptions.xai.maxTurns', () => {
  async function runWithXaiOptions(xai: Record<string, unknown>) {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const run = xaiAdapter({ client }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: xai as never } },
      }),
      FAKE_CTX,
    )
    return { client, run }
  }

  it('forwards max_turns with search tools', async () => {
    const { client, run } = await runWithXaiOptions({
      tools: [{ type: 'web_search' }],
      toolChoice: 'required',
      maxTurns: 3,
    })
    await run
    const call = client.calls[0] as { max_turns?: unknown; tool_choice?: unknown }
    expect(call.max_turns).toBe(3)
    expect(call.tool_choice).toBe('required')
  })

  it('sends no max_turns when the option is absent', async () => {
    const { client, run } = await runWithXaiOptions({ tools: [{ type: 'web_search' }] })
    await run
    expect('max_turns' in (client.calls[0] as object)).toBe(false)
  })

  it.each([0, -1, 1.5, '2', Number.NaN, null])(
    'rejects the invalid maxTurns value %j',
    async (maxTurns) => {
      const { client, run } = await runWithXaiOptions({
        tools: [{ type: 'web_search' }],
        maxTurns,
      })
      await expect(run).rejects.toMatchObject({
        kind: 'bad_request',
        message: expect.stringContaining('must be an integer >= 1'),
      })
      expect(client.calls).toHaveLength(0)
    },
  )

  it.each([{ maxTurns: 2 }, { tools: [], maxTurns: 2 }])(
    'rejects maxTurns without search tools: %j',
    async (xai) => {
      const { client, run } = await runWithXaiOptions(xai)
      await expect(run).rejects.toMatchObject({
        kind: 'bad_request',
        message: expect.stringContaining(
          'requires a non-empty providerOptions.xai.tools',
        ),
      })
      expect(client.calls).toHaveLength(0)
    },
  )
})

// ---------------------------------------------------------------------------
// Zero-search accounting
// ---------------------------------------------------------------------------

describe('search tools declared but no server tool ran', () => {
  it('prices exactly with no warning when the provider reports zero tools used', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 1000, outputTokens: 100 })
    response.usage['num_server_side_tools_used'] = 0
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: {
          providerOptions: {
            xai: {
              tools: [{ type: 'web_search' }, { type: 'x_search' }],
              toolChoice: 'none',
            },
          },
        },
      }),
      FAKE_CTX,
    )
    expect(result.warnings).toEqual([])
    expect(result.usage.details.server_tools_missing).toBeUndefined()
    expect(result.usage.details.num_server_side_tools_used).toBe(0)
    const cost = computeXaiCost('grok-4.5', result.usage)
    expect(cost.confidence).toBe('exact')
    expect(cost.details.tools).toBe(0)
    expect(cost.microUsd).toBe(2_000 + 600)
  })

  it('keeps the missing-counter state when a zero count arrives with counters', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['num_server_side_tools_used'] = 0
    response.usage['server_side_tool_usage_details'] = { x_posts_fetched: 1 }
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.server_tools_missing).toBe(1)
    expect(result.warnings[0]?.message).toContain('x_users_fetched')
    expect(computeXaiCost('grok-4.5', result.usage).microUsd).toBeNull()
  })

  it('keeps the attachment estimate when a zero count arrives with counters', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['num_server_side_tools_used'] = 0
    response.usage['server_side_tool_usage_details'] = { web_search_calls: 0 }
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        messages: [{ role: 'user', parts: [{ kind: 'file-ref', fileId: 'file_123' }] }],
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.attachment_search_unpinned).toBe(1)
    expect(computeXaiCost('grok-4.5', result.usage).confidence).toBe('estimated')
  })

  it('prices a file-ref call exactly when the provider reports no tool ran', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['num_server_side_tools_used'] = 0
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        messages: [{ role: 'user', parts: [{ kind: 'file-ref', fileId: 'file_123' }] }],
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.attachment_search_unpinned).toBeUndefined()
    expect(computeXaiCost('grok-4.5', result.usage).confidence).toBe('exact')
  })

  it('still flags missing counters when the provider does not report a tool count', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.server_tools_missing).toBe(1)
    expect(computeXaiCost('grok-4.5', result.usage).microUsd).toBeNull()
  })

  it('still flags missing counters when tools were used but details are absent', async () => {
    const response = fakeXaiResponse({ text: 'ok', inputTokens: 8, outputTokens: 2 })
    response.usage['num_server_side_tools_used'] = 2
    const result = await xaiAdapter({ client: makeFakeXai(response) }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.details.server_tools_missing).toBe(1)
    expect(result.warnings[0]?.message).toContain('web_search_calls')
  })
})

// ---------------------------------------------------------------------------
// Strict output schema dialect
// ---------------------------------------------------------------------------

describe('outputJsonSchema dialect preflight', () => {
  it('rejects an OpenAPI nullable keyword before dispatch', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '{}' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({
          modelDescriptor: grok45ModelDescriptor,
          outputJsonSchema: {
            type: 'object',
            properties: { employees: { type: 'string', nullable: true } },
            required: ['employees'],
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      provider: 'xai',
      message: expect.stringContaining('properties.employees'),
    })
    expect(client.calls).toHaveLength(0)
  })

  it('sends a standard JSON Schema unchanged, by reference', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '{"employees":null}' }))
    const schema = {
      type: 'object',
      properties: { employees: { type: ['string', 'null'] } },
      required: ['employees'],
    }
    const result = await xaiAdapter({ client }).run(
      makeResolvedReq({
        modelDescriptor: grok45ModelDescriptor,
        outputJsonSchema: schema,
      }),
      FAKE_CTX,
    )
    const sent = (client.calls[0] as { text: { format: { schema: unknown } } }).text
      .format
    expect(sent.schema).toBe(schema)
    expect(result.rawStructured).toEqual({ employees: null })
  })
})

// ---------------------------------------------------------------------------
// Declared model aliases (ADR-033)
// ---------------------------------------------------------------------------

describe('declared model aliases', () => {
  const aliased: ModelDescriptor = {
    ...grok45ModelDescriptor,
    aliases: ['grok-4.5-0415'],
  }

  it('accepts a declared alias on a first-turn dispatch and sends it to the SDK verbatim', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await xaiAdapter({ client }).run(
      makeResolvedReq({ model: 'grok-4.5-0415', modelDescriptor: aliased }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { model: string }).model).toBe('grok-4.5-0415')
  })

  it('rejects a string that is neither the canonical id nor a declared alias', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({ model: 'grok-4.5-0416', modelDescriptor: aliased }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects another provider’s descriptor whose alias list matches the requested string', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const foreign = makeTestDescriptor({
      provider: 'google',
      model: 'gemini-2.5-pro',
      aliases: ['grok-4.5-0415'],
    })
    await expect(
      xaiAdapter({ client }).run(
        makeResolvedReq({ model: 'grok-4.5-0415', modelDescriptor: foreign }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('through createClient: dispatches the alias verbatim and prices it under the canonical descriptor', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: createModelRegistry([aliased]),
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    const request = {
      provider: 'xai',
      model: 'grok-4.5-0415',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
      ],
    }

    const viaAlias = await llm.generate(request, { auth: { apiKey: 'test-key' } })
    const viaCanonical = await llm.generate(
      { ...request, model: 'grok-4.5' },
      { auth: { apiKey: 'test-key' } },
    )

    expect((client.calls[0] as { model: string }).model).toBe('grok-4.5-0415')
    expect((client.calls[1] as { model: string }).model).toBe('grok-4.5')
    expect(sink.records[0]!.model).toBe('grok-4.5-0415')
    expect(viaAlias.cost?.microUsd).not.toBeNull()
    expect(viaAlias.cost?.microUsd).toBe(viaCanonical.cost?.microUsd)

    await expect(
      llm.generate(
        { ...request, model: 'grok-4.5-0416' },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('middleware cannot reroute on the built-in registry (ADR-037)', () => {
  it('a swapped modelDescriptor and post-next provider/model assignments change neither the SDK model nor the price', async () => {
    const other = xaiRegistry.resolve('xai', 'grok-4.7')!
    const client = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: xaiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        {
          id: 'swapper',
          async intercept(req, ctx, next) {
            ;(req as { modelDescriptor?: ModelDescriptor }).modelDescriptor = other
            const out = await next(req, ctx)
            ;(req as { model: string }).model = 'grok-4.7'
            return out
          },
        },
      ],
    })

    const out = await llm.generate(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'test-key' } },
    )
    const baseline = xaiPricingSource().price('grok-4.5', out.usage)

    expect((client.calls[0] as { model: string }).model).toBe('grok-4.5')
    expect(out.cost?.microUsd).toBe(baseline.microUsd)
    expect(sink.records[0]!.model).toBe('grok-4.5')
  })
})

describe('reasoning used up the output cap (R1.9)', () => {
  it('a max_output_tokens response with only reasoning tokens carries the warning', async () => {
    const client = makeFakeXai(
      fakeXaiResponse({
        status: 'incomplete',
        incompleteReason: 'max_output_tokens',
        inputTokens: 20,
        outputTokens: 600,
        reasoningTokens: 600,
      }),
    )
    const llm = createClient({
      adapters: [xaiAdapter({ client })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: xaiRegistry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await llm.generate(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        config: { maxOutputTokens: 600 },
      },
      { auth: { apiKey: 'test-key' } },
    )

    expect(result.finishReason).toBe('length')
    expect(result.text).toBeUndefined()
    expect(result.warnings.map((w) => w.message)).toContain(
      'maxOutputTokens (600) was used up by reasoning (600 tokens); no answer was produced. Raise maxOutputTokens or lower the reasoning effort.',
    )
  })
})
