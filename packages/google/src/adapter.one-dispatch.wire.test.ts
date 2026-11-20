/**
 * No automatic continuation, the request-level logging override set, every
 * finish reason mapped explicitly.
 *
 * - Every generation request carries `store: false` and is sent with
 *   `automaticContinuation: false` (an SDK-side option, never serialized), for
 *   every registered model and on the standard dispatch after a flex capacity
 *   error.
 * - A response that ends with `CONTINUATION` and a continuation token is one
 *   fetch: `length`, this response's usage, a warning, incomplete calls dropped,
 *   the token neither replayed nor kept.
 * - The adapter's finish-reason table names every `FinishReason` member of the
 *   installed SDK, and each maps as documented.
 *
 * Real `@google/genai` with a stubbed `fetch`, or the structural fake; no
 * network. Response bodies are built in the documented REST shape
 * (https://aistudio.google.com/api-reference/generate-content.md, read
 * 2026-11-20); none is a capture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FinishReason as SdkFinishReason } from '@google/genai'
import type { AdapterCtx, ModelDescriptor, ResolvedRequest } from '@gullabs/core'
import { fakeGeminiResponse, makeFakeGemini } from '@gullabs/testing'

import { GEMINI_FINISH_REASONS, geminiAdapter } from './adapter.js'
import { defaultGeminiRegistry } from './models.js'

const CTX: AdapterCtx = {
  auth: { apiKey: 'wire-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const DESCRIPTORS: readonly ModelDescriptor[] = defaultGeminiRegistry.listDescriptors()
const FLEX_DESCRIPTORS = DESCRIPTORS.filter(
  (d) => d.capabilities?.serviceTiers?.includes('flex') === true,
)

function request(
  descriptor: ModelDescriptor,
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  return {
    provider: 'google',
    model: descriptor.model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: descriptor,
    ...overrides,
  }
}

interface Sent {
  url: string
  raw: string
  body: Record<string, unknown>
}
let sent: Sent[]
let responses: Array<{ status: number; body: unknown }>

beforeEach(() => {
  sent = []
  responses = []
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const raw = String(init.body ?? '{}')
    sent.push({ url: String(url), raw, body: JSON.parse(raw) as Record<string, unknown> })
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

const OK = {
  status: 200,
  body: {
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  },
}

/**
 * A response that ends with `CONTINUATION` and carries a continuation token: with
 * automatic continuation on, the SDK would send the request again.
 */
const continuation = (parts: unknown[]) => ({
  status: 200,
  body: {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: 'CONTINUATION',
        continuationToken: 'opaque-continuation-token',
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 5,
      totalTokenCount: 55,
    },
  },
})

describe('store: false and no automatic continuation on every generation dispatch', () => {
  it('the registry has models to check', () => {
    expect(DESCRIPTORS.length).toBeGreaterThan(0)
    expect(FLEX_DESCRIPTORS.length).toBeGreaterThan(0)
  })

  it.each(DESCRIPTORS.map((d) => [d.model, d] as const))(
    '%s: the serialized request carries store: false and no continuation field',
    async (_model, descriptor) => {
      responses.push(OK)
      await geminiAdapter().run(request(descriptor), CTX)
      expect(sent).toHaveLength(1)
      expect(sent[0]!.url).toContain(`/v1beta/models/${descriptor.model}:generateContent`)
      expect(sent[0]!.body['store']).toBe(false)
      expect(sent[0]!.raw).not.toContain('automaticContinuation')
      expect(sent[0]!.raw).not.toContain('continuationToken')
    },
  )

  it.each(FLEX_DESCRIPTORS.map((d) => [d.model, d] as const))(
    '%s: the standard dispatch after a flex capacity error is one request (it is not continued) and carries store: false too',
    async (_model, descriptor) => {
      responses.push({
        status: 503,
        body: { error: { code: 503, message: 'at capacity', status: 'UNAVAILABLE' } },
      })
      // The standard dispatch ends with CONTINUATION and a token: if that dispatch
      // lost automaticContinuation: false, the SDK would send a third request and
      // consume the response queued after it.
      responses.push(continuation([{ text: 'partial answer' }]))
      responses.push(OK)
      const result = await geminiAdapter().run(
        request(descriptor, { config: { serviceTier: 'flex' } }),
        CTX,
      )
      expect(result.servedServiceTier).toBe('standard')
      expect(result.finishReason).toBe('length')
      expect(result.text).toBe('partial answer')
      expect(sent).toHaveLength(2)
      expect(responses).toHaveLength(1)
      expect(sent.map((s) => s.body['store'])).toEqual([false, false])
      expect(
        sent.map(
          (s) =>
            (s.body['generationConfig'] as { serviceTier?: unknown })?.serviceTier ??
            s.body['serviceTier'],
        ),
      ).toEqual(['flex', 'standard'])
      for (const s of sent) expect(s.raw).not.toContain('automaticContinuation')
    },
  )
})

describe('a CONTINUATION finish is one fetch, returned as length', () => {
  it.each(DESCRIPTORS.map((d) => [d.model, d] as const))(
    '%s: one request, this response usage, a warning, the token not kept',
    async (_model, descriptor) => {
      responses.push(continuation([{ text: 'partial answer' }]))
      // A second queued response would be consumed if the SDK resumed.
      responses.push(OK)
      const result = await geminiAdapter().run(request(descriptor), CTX)
      expect(sent).toHaveLength(1)
      expect(result.finishReason).toBe('length')
      expect(result.text).toBe('partial answer')
      expect(result.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 45,
        totalTokens: 55,
      })
      const warning = result.warnings.map((w) => w.message).join('\n')
      expect(warning).toContain('finishReason CONTINUATION')
      expect(warning).toContain('does not resume with the continuation token')
      expect(JSON.stringify(result)).not.toContain('opaque-continuation-token')
    },
  )

  it('a function call beside CONTINUATION is incomplete: dropped and named', async () => {
    const descriptor = DESCRIPTORS.find((d) => d.capabilities?.functionCalling === true)!
    responses.push(
      continuation([
        { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
      ]),
    )
    const result = await geminiAdapter().run(
      request(descriptor, {
        tools: [
          {
            name: 'lookup',
            description: 'Look something up',
            inputJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      }),
      CTX,
    )
    expect(sent).toHaveLength(1)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.message.parts).toEqual([])
    const warning = result.warnings.map((w) => w.message).join('\n')
    expect(warning).toContain('"lookup"')
    expect(warning).toContain('per-request output limit before generation finished')
  })
})

describe('finish reasons', () => {
  /** Expected mapping per SDK member, from the SDK's enum documentation. */
  const EXPECTED: Record<string, 'stop' | 'length' | 'content_filter' | 'other'> = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    CONTINUATION: 'length',
    SAFETY: 'content_filter',
    RECITATION: 'content_filter',
    BLOCKLIST: 'content_filter',
    PROHIBITED_CONTENT: 'content_filter',
    SPII: 'content_filter',
    IMAGE_SAFETY: 'content_filter',
    IMAGE_PROHIBITED_CONTENT: 'content_filter',
    IMAGE_RECITATION: 'content_filter',
    ESCALATION: 'content_filter',
    PUP_LIMITED_DISABLED: 'content_filter',
    MODEL_ARMOR: 'content_filter',
    FINISH_REASON_UNSPECIFIED: 'other',
    OTHER: 'other',
    LANGUAGE: 'other',
    MALFORMED_FUNCTION_CALL: 'other',
    UNEXPECTED_TOOL_CALL: 'other',
    TOO_MANY_TOOL_CALLS: 'other',
    MISSING_THOUGHT_SIGNATURE: 'other',
    MALFORMED_RESPONSE: 'other',
    IMAGE_OTHER: 'other',
    NO_IMAGE: 'other',
  }

  it('the table names exactly the members of the installed SDK enum', () => {
    const sdkMembers = Object.values(SdkFinishReason).sort()
    expect(Object.keys(GEMINI_FINISH_REASONS).sort()).toEqual(sdkMembers)
    expect(Object.keys(EXPECTED).sort()).toEqual(sdkMembers)
  })

  const descriptor = DESCRIPTORS[0]!
  it.each(Object.entries(EXPECTED))(
    '%s with answer text is returned as %s',
    async (raw, expected) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'x', finishReason: raw }))
      const result = await geminiAdapter({ client }).run(request(descriptor), CTX)
      expect(result.finishReason).toBe(expected)
      expect(result.providerMetadata).toMatchObject({
        google: { candidate: { finishReason: raw } },
      })
    },
  )

  it('a value the SDK does not know is other', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'x', finishReason: 'SOMETHING_NEW' }),
    )
    const result = await geminiAdapter({ client }).run(request(descriptor), CTX)
    expect(result.finishReason).toBe('other')
  })
})
