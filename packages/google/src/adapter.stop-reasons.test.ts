/**
 * @gullabs/google — what a stopped candidate and a usage-less 200 become.
 *
 * - A function call beside a non-`STOP` finish is not a complete call: it is
 *   dropped from `toolCalls` and the assistant message, a warning names it, and
 *   the finish reason says why (`length`, `content_filter`, `other`).
 * - A 200 without `usageMetadata` is unknown usage, not an exact $0.
 *
 * Responses are hand-built in the captured shape (ADR-013); no network.
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { fakeGeminiResponse, makeFakeGemini } from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry } from './models.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const MODEL = 'gemini-2.5-flash'

const TOOL = {
  name: 'get_temperature',
  description: 'Get temperature',
  inputJsonSchema: { type: 'object' as const, properties: { city: { type: 'string' } } },
}

function makeReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'google',
    model: MODEL,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Weather?' }] }],
    config: {},
    tools: [TOOL],
    modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
    ...overrides,
  }
}

const CALL = { functionCall: { name: 'get_temperature', args: { city: 'Rome' } } }

describe('a function call beside a non-STOP finish', () => {
  it('MAX_TOKENS: the call is incomplete, so the result is length with no tool call and a warning', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'MAX_TOKENS',
        parts: [CALL],
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      }),
    )
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.message.parts.some((part) => part.kind === 'tool-call')).toBe(false)
    const warning = result.warnings.map((w) => w.message).join('\n')
    expect(warning).toContain('"get_temperature"')
    expect(warning).toContain('MAX_TOKENS')
    expect(warning).toContain('cut by the output cap')
  })

  it('MAX_TOKENS with text keeps the text and drops only the call', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'Let me check',
        finishReason: 'MAX_TOKENS',
        parts: [CALL],
      }),
    )
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.text).toBe('Let me check')
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.message.parts).toEqual([{ kind: 'text', text: 'Let me check' }])
  })

  it('SAFETY with text: content_filter, call dropped and named', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'partial',
        finishReason: 'SAFETY',
        parts: [CALL],
      }),
    )
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.finishReason).toBe('content_filter')
    expect(result.toolCalls).toBeUndefined()
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      '"get_temperature"',
    )
  })

  it('SAFETY with only the call is the content_filter failure, billed and not retryable', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'SAFETY',
        parts: [CALL],
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      }),
    )
    const err = await geminiAdapter({ client })
      .run(makeReq(), FAKE_CTX)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('content_filter')
    expect((err as LlmError).retryable).toBe(false)
    expect((err as LlmError).usage).toMatchObject({ inputTokens: 10 })
  })

  it('OTHER: finishReason other, call dropped', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ finishReason: 'OTHER', parts: [CALL] }),
    )
    const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
    expect(result.finishReason).toBe('other')
    expect(result.toolCalls).toBeUndefined()
  })

  it.each([undefined, 'STOP'])(
    'a complete call (finish %s) is still tool_calls',
    async (finishReason) => {
      const client = makeFakeGemini(
        fakeGeminiResponse({
          parts: [CALL],
          ...(finishReason !== undefined ? { finishReason } : {}),
        }),
      )
      const result = await geminiAdapter({ client }).run(makeReq(), FAKE_CTX)
      expect(result.finishReason).toBe('tool_calls')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.warnings).toEqual([])
    },
  )

  it('a signed call that is dropped adds no signature entry and no missing-signature warning', async () => {
    const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.6-flash')!
    const client = makeFakeGemini(
      fakeGeminiResponse({
        finishReason: 'MAX_TOKENS',
        text: 'x',
        parts: [{ ...CALL, thoughtSignature: 'sig-1' }],
      }),
    )
    const result = await geminiAdapter({ client }).run(
      makeReq({ model: 'gemini-3.6-flash', modelDescriptor: descriptor }),
      FAKE_CTX,
    )
    expect(result.toolCalls).toBeUndefined()
    const text = result.warnings.map((w) => w.message).join('\n')
    expect(text).not.toContain('thoughtSignature')
    expect(JSON.stringify(result.transientProviderState ?? null)).not.toContain('sig-1')
  })
})

describe('a 200 without usageMetadata', () => {
  it('is unknown usage: unpriced and estimated with a warning, never an exact $0', async () => {
    const client = makeFakeGemini({
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    })
    const result = await geminiAdapter({ client }).run(makeReq({ tools: [] }), FAKE_CTX)
    expect(result.text).toBe('hello')
    expect(result.usage.details['usage_missing']).toBe(1)
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      'carries no usageMetadata',
    )
    const cost = geminiPricingSource().price(MODEL, result.usage, undefined)
    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toContain('usageMetadata')
  })

  it('a response that reports usage is priced exact as before', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'hello',
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      }),
    )
    const result = await geminiAdapter({ client }).run(makeReq({ tools: [] }), FAKE_CTX)
    expect(result.usage.details).not.toHaveProperty('usage_missing')
    const cost = geminiPricingSource().price(MODEL, result.usage, undefined)
    expect(cost.confidence).toBe('exact')
    expect(cost.microUsd).not.toBeNull()
  })
})
