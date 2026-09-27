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

  it('forwards tools as functionDeclarations and stays exact', async () => {
    const client = makeFakeGemini({ candidates: [] }, { totalTokens: 9 })
    const adapter = geminiAdapter({ client })
    const result = await adapter.countTokens!(
      makeCountReq({
        tools: [
          {
            name: 'get_temperature',
            description: 'Get temperature',
            inputJsonSchema: { type: 'object' },
          },
        ],
      }),
      FAKE_CTX,
    )
    expect(result.accuracy).toBe('exact')
    const call = client.countTokensCalls[0] as {
      config?: { tools?: unknown }
    }
    expect(call.config?.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_temperature',
            description: 'Get temperature',
            parameters: { type: 'object' },
          },
        ],
      },
    ])
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

  it('run() and countTokens() send identical `systemInstruction` for the same system', async () => {
    const system = 'You are a helpful assistant.'
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
        system,
        config: {},
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
      },
      FAKE_CTX,
    )
    await countAdapter.countTokens!(makeCountReq({ messages, system }), FAKE_CTX)

    type SystemCarrier = {
      config?: { systemInstruction?: { parts: Array<{ text: string }> } }
    }
    const runCall = runClient.calls[0] as SystemCarrier
    const countCall = countClient.countTokensCalls[0] as SystemCarrier
    expect(countCall.config?.systemInstruction).toEqual(runCall.config?.systemInstruction)
    expect(countCall.config?.systemInstruction?.parts[0]?.text).toBe(system)
  })
})
