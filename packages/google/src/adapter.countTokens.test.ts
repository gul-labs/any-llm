/**
 * @gullabs/google — geminiAdapter.countTokens contract tests.
 *
 * Split out from adapter.test.ts (mirrors provider-options.test.ts being
 * split out) — all tests use fakes from @gullabs/testing, NO real network
 * calls.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient } from '@gullabs/core'
import type { AdapterCtx, TokenCountRequest, Message } from '@gullabs/core'
import { makeFakeGemini } from '@gullabs/testing'
import { geminiAdapter, mapMessagesToGeminiContents } from './adapter.js'
import { defaultGeminiRegistry } from './models.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeCountReq(overrides: Partial<TokenCountRequest> = {}): TokenCountRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    ...overrides,
  }
}

describe('geminiAdapter.countTokens — happy path', () => {
  it('maps a scripted SDK response into the TokenCount shape', async () => {
    const client = makeFakeGemini(
      { candidates: [] },
      { totalTokens: 42, cachedContentTokenCount: 10 },
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.countTokens!(makeCountReq(), FAKE_CTX)

    expect(result.totalTokens).toBe(42)
    expect(result.accuracy).toBe('exact')
    expect(result.details).toEqual({ cached: 10 })
    expect(result.raw).toEqual({ totalTokens: 42, cachedContentTokenCount: 10 })
  })

  it('omits details when cachedContentTokenCount is absent', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 5 })
    const adapter = geminiAdapter({ client })

    const result = await adapter.countTokens!(makeCountReq(), FAKE_CTX)

    expect(result.totalTokens).toBe(5)
    expect(result.accuracy).toBe('exact')
    expect(result.details).toBeUndefined()
  })
})

describe('geminiAdapter.countTokens — messages only', () => {
  it('sends neither systemInstruction nor tools nor config when there is nothing to carry', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 9 })
    const adapter = geminiAdapter({ client })
    await adapter.countTokens!(makeCountReq(), FAKE_CTX)
    const call = client.countTokensCalls[0] as Record<string, unknown>
    expect(call).not.toHaveProperty('systemInstruction')
    expect(call).not.toHaveProperty('tools')
    expect(call['config']).toBeUndefined()
  })
})

describe('geminiAdapter.countTokens — error classification', () => {
  it('classifies SDK errors thrown from countTokens the same way run() does', async () => {
    const client = makeFakeGemini({ candidates: [] }, () => {
      throw { status: 429 }
    })
    const adapter = geminiAdapter({ client })

    await expect(adapter.countTokens!(makeCountReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      provider: 'google',
    })
  })

  it('missing totalTokens in the SDK response → server LlmError (provider fault)', async () => {
    const client = makeFakeGemini({ candidates: [] }, {})
    const adapter = geminiAdapter({ client })

    await expect(adapter.countTokens!(makeCountReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
      provider: 'google',
      message: expect.stringContaining('missing required field: totalTokens'),
    })
  })

  it('req.provider !== "google" → bad_request', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 1 })
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.countTokens!(makeCountReq({ provider: 'openai' }), FAKE_CTX),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })
})

describe('geminiAdapter.countTokens — abortSignal propagation', () => {
  it('propagates ctx.signal into config.abortSignal', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 1 })
    const adapter = geminiAdapter({ client })
    const controller = new AbortController()

    await adapter.countTokens!(makeCountReq(), { ...FAKE_CTX, signal: controller.signal })

    const call = client.countTokensCalls[0] as {
      config?: { abortSignal?: AbortSignal }
    }
    expect(call.config?.abortSignal).toBe(controller.signal)
  })
})

describe('geminiAdapter.countTokens — message-mapping parity with run()', () => {
  const messages: Message[] = [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'Describe this image' },
        { kind: 'inline-media', mimeType: 'image/png', data: 'YmFzZTY0' },
      ],
    },
    { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  ]

  it('mapMessagesToGeminiContents produces the expected contents shape directly', () => {
    const contents = mapMessagesToGeminiContents(messages)
    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Describe this image' },
          { inlineData: { mimeType: 'image/png', data: 'YmFzZTY0' } },
        ],
      },
      { role: 'model', parts: [{ text: 'ok' }] },
    ])
  })

  it('run() and countTokens() send identical `contents` for the same messages', async () => {
    const runClient = makeFakeGemini({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: {},
    })
    const countClient = makeFakeGemini({ candidates: [] }, { totalTokens: 1 })

    const runAdapter = geminiAdapter({ client: runClient })
    const countAdapter = geminiAdapter({ client: countClient })

    await runAdapter.run(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages,
        config: {},
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
      },
      FAKE_CTX,
    )
    await countAdapter.countTokens!(makeCountReq({ messages }), FAKE_CTX)

    const runCall = runClient.calls[0] as { contents: unknown }
    const countCall = countClient.countTokensCalls[0] as { contents: unknown }
    expect(countCall.contents).toEqual(runCall.contents)
  })
})

describe('geminiAdapter.countTokens — accuracy when function calls are in the history', () => {
  const withCall: Message[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'Weather?' }] },
    {
      role: 'assistant',
      parts: [
        { kind: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', args: {} },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          kind: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          result: { tempC: 18 },
        },
      ],
    },
  ]
  const textOnly: Message[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'Hi' }] },
    { role: 'assistant', parts: [{ kind: 'text', text: 'Hello' }] },
  ]
  const ctxFor = (model: string): AdapterCtx => ({
    ...FAKE_CTX,
    modelDescriptor: defaultGeminiRegistry.resolve('google', model)!,
  })

  it('is estimated on a Gemini 3 model: countTokens sends no signatures, so generate() bills more', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 50 })
    const result = await geminiAdapter({ client }).countTokens!(
      makeCountReq({ model: 'gemini-3.1-pro-preview', messages: withCall }),
      ctxFor('gemini-3.1-pro-preview'),
    )
    expect(result.totalTokens).toBe(50)
    expect(result.accuracy).toBe('estimated')
    // The call is sent without a signature (the live endpoint accepts that).
    const sent = (client.countTokensCalls[0] as { contents: Array<{ parts: unknown[] }> })
      .contents[1]?.parts[0] as Record<string, unknown>
    expect(sent['functionCall']).toMatchObject({ name: 'get_weather' })
    expect(sent['thoughtSignature']).toBeUndefined()
  })

  it.each([
    ['a Gemini 3 model without function calls', 'gemini-3.1-pro-preview', textOnly],
    [
      'Gemini 2.5, which has no signatures, with function calls',
      'gemini-2.5-pro',
      withCall,
    ],
  ])('stays exact for %s', async (_label, model, messages) => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 7 })
    const result = await geminiAdapter({ client }).countTokens!(
      makeCountReq({ model, messages }),
      ctxFor(model),
    )
    expect(result.accuracy).toBe('exact')
  })

  it('the engine hands the adapter the resolved descriptor, so the client reports estimated', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 50 })
    const engine = createClient({
      adapters: [geminiAdapter({ client })],
      modelRegistry: defaultGeminiRegistry,
    })
    const estimated = await engine.countTokens(
      makeCountReq({ model: 'gemini-3.1-pro-preview', messages: withCall }),
      { auth: { apiKey: 'k' } },
    )
    expect(estimated.accuracy).toBe('estimated')
    const exact = await engine.countTokens(
      makeCountReq({ model: 'gemini-3.1-pro-preview', messages: textOnly }),
      { auth: { apiKey: 'k' } },
    )
    expect(exact.accuracy).toBe('exact')
  })
})
