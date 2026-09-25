/**
 * @gullabs/xai — adapter contract tests.
 *
 * All tests use fakes from @gullabs/testing — NO real network calls.
 * makeFakeXai/fakeXaiResponse are the sole test doubles.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx, ModelDescriptor } from '@gullabs/core'
import { fakeXaiResponse, makeFakeXai, RecordingSink } from '@gullabs/testing'
import { xaiAdapter, classifyXaiError } from './adapter.js'
import { xaiRegistry, grok45ModelDescriptor, grok47ModelDescriptor } from './models.js'
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

    expect(factory).toHaveBeenCalledWith(FAKE_CTX.auth)
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

  it('classifies APIConnectionTimeoutError (subclass of APIConnectionError) as retryable', () => {
    // The openai SDK's default message for this subclass is "Request timed
    // out.", which core's classifyError already recognizes via its own
    // timeout heuristic (kind: 'timeout', retryable: true) — so this never
    // even needs the transport-fallback path to be safe to retry. Confirm
    // it does NOT fall through to the non-retryable 'unknown' kind.
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {
      constructor() {
        super('Request timed out.')
      }
    }
    const result = classifyXaiError(new APIConnectionTimeoutError())
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('classifies an APIConnectionTimeoutError with a non-timeout-worded message via the transport fallback', () => {
    // Simulate a caller-supplied custom message that does not happen to
    // contain the word "timeout" — the constructor-name check must still
    // catch it.
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {
      constructor() {
        super('Connection error.')
      }
    }
    const result = classifyXaiError(new APIConnectionTimeoutError())
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
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
        modelDescriptor: grok45ModelDescriptor,
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

  it('replays grok-4.7 function-call items unchanged on store:false', async () => {
    const client = makeFakeXai(fakeXaiResponse({ text: '59F' }))
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
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
