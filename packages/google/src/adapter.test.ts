/**
 * @gullabs/google — adapter contract tests.
 *
 * All tests use fakes from @gullabs/testing — NO real network calls.
 * makeFakeGemini/fakeGeminiResponse/fakeGeminiBlocked are the sole test doubles.
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  LlmError,
  createClient,
  createModelRegistry,
  retryMiddleware,
} from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx, ModelDescriptor } from '@gullabs/core'
import type { ProviderOptions } from '@gullabs/core'
import {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
  FakeClock,
  FakeIds,
  RecordingSink,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { isGeminiCapacityError } from './flex-fallback.js'
import { FLEX_DEFAULT_TIMEOUT_MS } from './client.js'
import type { GeminiClientLike, GeminiResponseShape } from './client.js'
import { GOOGLE_REASONING_EFFORT_BUDGET } from './reasoning-budget.js'
import { geminiPricingSource } from './cost.js'
import { gemmaModelDescriptors, geminiModelDescriptors } from './models.js'
import { defaultGeminiRegistry } from './models.js'
import { makeTestDescriptor } from '../../core/src/test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal resolved request for unit tests. */
function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: { serviceTier: 'flex' },
    modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
    ...overrides,
  }
}

/** Minimal adapter context for unit tests. */
const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeGoogleDescriptor(
  overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'model'>,
): ModelDescriptor {
  return makeTestDescriptor({
    provider: 'google',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 0. Observability — debug log
// ---------------------------------------------------------------------------

describe('observability', () => {
  it('emits llm.adapter.dispatch debug log before SDK call', async () => {
    const debugFn = vi.fn()
    const ctx: AdapterCtx = {
      auth: { apiKey: 'test-key' },
      logger: { info() {}, warn() {}, error() {}, debug: debugFn },
    }
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'hi' }))
    const adapter = geminiAdapter({ client })
    await adapter.run(makeResolvedReq(), ctx)

    expect(debugFn).toHaveBeenCalledOnce()
    const [obj, msg] = debugFn.mock.calls[0]!
    expect(msg).toBe('llm.adapter.dispatch')
    expect(obj).toMatchObject({ model: 'gemini-2.5-pro' })
    expect(Array.isArray(obj.configKeys)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 1. Usage mapping — the #1 correctness rule
// ---------------------------------------------------------------------------

describe('usage mapping', () => {
  it('enforces GROSS convention: outputTokens = candidates + thoughts', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'Hello world',
        promptTokenCount: 1000,
        candidatesTokenCount: 5000,
        thoughtsTokenCount: 2000,
        cachedContentTokenCount: 300,
        totalTokenCount: 8300,
        finishReason: 'STOP',
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    // The #1 rule: outputTokens = candidatesTokenCount + thoughtsTokenCount
    expect(result.usage.outputTokens).toBe(7000) // 5000 + 2000
    expect(result.usage.inputTokens).toBe(1000)
    expect(result.usage.thinkingTokens).toBe(2000)
    // cachedInputTokens = cachedContentTokenCount (subset of inputTokens)
    expect(result.usage.cachedInputTokens).toBe(300)
    expect(result.usage.totalTokens).toBe(8300)
  })

  it('populates details with canonical keys', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'hi',
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 10,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.details).toMatchObject({
      input: 100,
      output: 70, // 50 + 20
      cached: 10,
      thinking: 20,
    })
  })

  it('populates raw with the original usageMetadata', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 20,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.raw).toMatchObject({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
    })
  })

  it('handles missing usageMetadata gracefully (all zeroes)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
    expect(result.usage.thinkingTokens).toBeUndefined()
    expect(result.usage.cachedInputTokens).toBeUndefined()
  })

  it('outputs no thinkingTokens when thoughtsTokenCount is absent', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'plain',
        candidatesTokenCount: 10,
        promptTokenCount: 5,
      }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.outputTokens).toBe(10) // 10 + 0
    expect(result.usage.thinkingTokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Service tier — explicit tiers only
// ---------------------------------------------------------------------------

describe('service tier', () => {
  it('uses the provider-echoed served tier when it differs from the request', async () => {
    const response = fakeGeminiResponse({ text: 'ok' }) as GeminiResponseShape
    response.usageMetadata = { ...response.usageMetadata, serviceTier: 'standard' }
    const client = makeFakeGemini(response)
    const result = await geminiAdapter({ client }).run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: { google: { flexFallback: false } },
        },
      }),
      FAKE_CTX,
    )
    expect(result.servedServiceTier).toBe('standard')
    expect(result.usage.raw).toMatchObject({ serviceTier: 'standard' })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('provider served "standard"'),
      }),
    ])
  })

  it('sends serviceTier="flex" when config.serviceTier is flex', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBe('flex')
  })

  it('sends serviceTier="standard" when config.serviceTier is standard', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'standard' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBe('standard')
  })

  it('omits serviceTier when a flex-capable model has no explicit tier', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: descriptor,
        config: {} as ResolvedRequest['config'],
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBeUndefined()
  })

  it('omits serviceTier without warning when the model descriptor has no supported service tiers and no explicit tier is requested', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const gemma = gemmaModelDescriptors.find((d) => d.model === 'gemma-4-31b-it')!

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemma-4-31b-it',
        modelDescriptor: gemma,
        config: {} as ResolvedRequest['config'],
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { serviceTier?: string } }
    expect(call?.config?.serviceTier).toBeUndefined()
    expect(result.warnings).toEqual([])
  })

  it('throws LlmError bad_request when explicitly requesting a tier the model does not support', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'google-standard-only-model',
          modelDescriptor: makeGoogleDescriptor({
            model: 'google-standard-only-model',
            capabilities: { serviceTiers: ['standard'] },
          }),
          config: { serviceTier: 'flex' },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('throws LlmError bad_request when explicitly requesting serviceTier on a model that declares no serviceTiers', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const gemma = gemmaModelDescriptors.find((d) => d.model === 'gemma-4-31b-it')!

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemma-4-31b-it',
          modelDescriptor: gemma,
          config: { serviceTier: 'flex' },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })
})

// ---------------------------------------------------------------------------
// 2b. Flex fallback
// ---------------------------------------------------------------------------

describe('flex fallback', () => {
  it('classifies only 503 server errors and capacity-flavored 429s as fallbackable', () => {
    expect(
      isGeminiCapacityError(
        new LlmError('unavailable', {
          kind: 'server',
          retryable: true,
          httpStatus: 503,
        }),
      ),
    ).toBe(true)
    expect(
      isGeminiCapacityError(
        new LlmError('internal error', {
          kind: 'server',
          retryable: true,
          httpStatus: 500,
        }),
      ),
    ).toBe(false)
    expect(
      isGeminiCapacityError(
        new LlmError('shared capacity is overloaded', {
          kind: 'rate_limited',
          retryable: true,
          httpStatus: 429,
        }),
      ),
    ).toBe(true)
    expect(
      isGeminiCapacityError(
        new LlmError('quota exceeded for project billing account', {
          kind: 'rate_limited',
          retryable: true,
          httpStatus: 429,
        }),
      ),
    ).toBe(false)
  })

  it('falls back from flex 503 capacity error to one standard attempt', async () => {
    let callCount = 0
    const client = makeFakeGemini(() => {
      callCount++
      if (callCount === 1) {
        throw { status: 503, message: 'no capacity available' }
      }
      return fakeGeminiResponse({ text: 'ok' })
    })
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex' } }),
      FAKE_CTX,
    )

    expect(result.servedServiceTier).toBe('standard')
    expect(client.calls).toHaveLength(2)
    expect(
      (client.calls[0] as { config?: { serviceTier?: string } }).config?.serviceTier,
    ).toBe('flex')
    expect(
      (client.calls[1] as { config?: { serviceTier?: string } }).config?.serviceTier,
    ).toBe('standard')
  })

  it('does not fall back when flexFallback is false', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 503, message: 'no capacity available' }
    })
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            serviceTier: 'flex',
            providerOptions: { google: { flexFallback: false } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'server', servedServiceTier: 'flex' })
    expect(client.calls).toHaveLength(1)
  })

  it('keeps retries pinned to standard after adapter fallback failure', async () => {
    let dispatchCount = 0
    const fakeClient = makeFakeGemini((params) => {
      dispatchCount++
      const serviceTier = (params as { config?: { serviceTier?: string } }).config
        ?.serviceTier
      if (dispatchCount === 1) {
        expect(serviceTier).toBe('flex')
        throw { status: 503, message: 'no capacity available' }
      }
      if (dispatchCount === 2) {
        expect(serviceTier).toBe('standard')
        throw { status: 503, message: 'standard transient' }
      }
      expect(serviceTier).toBe('standard')
      return fakeGeminiResponse({ text: 'ok' })
    })
    const sink = new RecordingSink()
    const llmClient = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 2, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0, now: () => 0 },
        ),
      ],
    })

    const result = await llmClient.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        config: { serviceTier: 'flex' },
      },
      { auth: { apiKey: 'test-key' } },
    )

    expect(fakeClient.calls).toHaveLength(3)
    expect(result.servedServiceTier).toBe('standard')
    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]!.servedServiceTier).toBe('standard')
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[1]!.servedServiceTier).toBe('standard')
    expect(sink.records[1]!.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 3. Reasoning / thinkingConfig mapping
// ---------------------------------------------------------------------------

describe('reasoning mapping', () => {
  it('maps effort to thinkingBudget for gemini-2.5 models using the adapter-owned budget table', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-2.5-pro',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: {
          serviceTier: 'flex',
          reasoning: { effort: 'high' },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(
      GOOGLE_REASONING_EFFORT_BUDGET.high,
    )
  })

  it('uses budgetTokens directly for gemini-2.5 models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-flash',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-2.5-flash',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: {
          serviceTier: 'flex',
          reasoning: { budgetTokens: 4096 },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(4096)
  })

  it('maps admitted none effort to thinkingBudget=0 for gemini-2.5-flash', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-flash',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-2.5-flash',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            admittedReasoningEfforts: ['none', 'low', 'medium', 'high'],
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: { serviceTier: 'flex', reasoning: { effort: 'none' } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingBudget?: number } }
    }
    expect(call?.config?.thinkingConfig?.thinkingBudget).toBe(0)
  })

  it('maps effort to thinkingLevel for gemini-3.x models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.0-pro',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-3.0-pro',
          capabilities: {
            reasoning: true,
            reasoningApi: 'level',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: {
          serviceTier: 'flex',
          reasoning: { effort: 'high' },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingLevel?: string } }
    }
    expect(call?.config?.thinkingConfig?.thinkingLevel).toBe('HIGH')
  })

  it('maps low effort to LOW thinkingLevel for gemini-3.x', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.5-pro',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-3.5-pro',
          capabilities: {
            reasoning: true,
            reasoningApi: 'level',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: { serviceTier: 'flex', reasoning: { effort: 'low' } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { thinkingLevel?: string } }
    }
    expect(call?.config?.thinkingConfig?.thinkingLevel).toBe('LOW')
  })

  it('never emits MINIMAL when the shipped descriptor omits effort none', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const descriptors = geminiModelDescriptors.filter(
      (desc) =>
        desc.capabilities?.reasoningApi === 'level' &&
        desc.capabilities.admittedReasoningEfforts !== undefined &&
        !desc.capabilities.admittedReasoningEfforts.includes('none'),
    )
    expect(descriptors.map((desc) => desc.model).sort()).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
    ])

    for (const modelDescriptor of descriptors) {
      await expect(
        adapter.run(
          makeResolvedReq({
            model: modelDescriptor.model,
            modelDescriptor,
            config: { reasoning: { effort: 'none' } },
          }),
          FAKE_CTX,
        ),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    }
    expect(client.calls).toHaveLength(0)
  })

  it('rejects none on a budget model whose descriptor does not admit it', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-2.5-pro',
          modelDescriptor: descriptor,
          config: { reasoning: { effort: 'none' } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects reasoning.effort=xhigh on Gemini budget models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-2.5-pro',
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-2.5-pro',
            capabilities: {
              reasoning: true,
              reasoningApi: 'budget',
              serviceTiers: ['flex', 'standard'],
            },
          }),
          config: { serviceTier: 'flex', reasoning: { effort: 'xhigh' } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects reasoning.effort=xhigh on Gemini level models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-3.1-flash-lite',
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-3.1-flash-lite',
            capabilities: {
              reasoning: true,
              reasoningApi: 'level',
              serviceTiers: ['flex', 'standard'],
            },
          }),
          config: { serviceTier: 'flex', reasoning: { effort: 'xhigh' } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('throws LlmError bad_request for gemini-3.x with budgetTokens', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-3.0-ultra',
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-3.0-ultra',
            capabilities: {
              reasoning: true,
              reasoningApi: 'level',
              serviceTiers: ['flex', 'standard'],
            },
          }),
          config: { serviceTier: 'flex', reasoning: { budgetTokens: 1000 } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('throws LlmError bad_request when both effort and budgetTokens are provided', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-2.5-pro',
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-2.5-pro',
            capabilities: {
              reasoning: true,
              structuredOutput: true,
              reasoningApi: 'budget',
              serviceTiers: ['flex', 'standard'],
            },
          }),
          config: {
            serviceTier: 'flex',
            reasoning: { effort: 'high', budgetTokens: 4096 },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('captures reasoningText from thought parts when includeThoughts=true', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        thoughtText: 'I am thinking...',
        text: 'The answer is 42.',
        thoughtsTokenCount: 100,
        candidatesTokenCount: 10,
      }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-2.5-pro',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: { serviceTier: 'flex', reasoning: { includeThoughts: true } },
      }),
      FAKE_CTX,
    )

    expect(result.reasoningText).toBe('I am thinking...')
    expect(result.text).toBe('The answer is 42.')
  })

  it('sets includeThoughts in thinkingConfig when reasoning.includeThoughts is true', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', thoughtText: 'thinking' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        model: 'gemini-2.5-pro',
        modelDescriptor: makeGoogleDescriptor({
          model: 'gemini-2.5-pro',
          capabilities: {
            reasoning: true,
            structuredOutput: true,
            reasoningApi: 'budget',
            serviceTiers: ['flex', 'standard'],
          },
        }),
        config: { serviceTier: 'flex', reasoning: { includeThoughts: true } },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { thinkingConfig?: { includeThoughts?: boolean } }
    }
    expect(call?.config?.thinkingConfig?.includeThoughts).toBe(true)
  })

  it('throws LlmError bad_request when reasoning is requested for a model without reasoningApi', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-future-model',
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-future-model',
            capabilities: { serviceTiers: ['flex', 'standard'] },
          }),
          config: { serviceTier: 'flex', reasoning: { effort: 'medium' } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })
})

// ---------------------------------------------------------------------------
// 4. Structured output
// ---------------------------------------------------------------------------

describe('structured output', () => {
  it('sets responseMimeType=application/json for structured requests', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Alice"}' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', additionalProperties: true },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { responseMimeType?: string } }
    expect(call?.config?.responseMimeType).toBe('application/json')
  })

  it('forwards JSON Schema directly as responseSchema', async () => {
    const jsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
    }
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Alice","age":30}' }),
    )
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ outputJsonSchema: jsonSchema }), FAKE_CTX)

    const call = client.calls[0] as {
      config?: {
        responseSchema?: { type?: string; properties?: Record<string, { type?: string }> }
      }
    }
    expect(call?.config?.responseSchema?.type).toBe('object')
    expect(call?.config?.responseSchema?.properties?.['name']?.type).toBe('string')
    expect(call?.config?.responseSchema?.properties?.['age']?.type).toBe('number')
  })

  it('skips responseMimeType and responseSchema when native structured output is disabled', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: '{"pass":true}' }))
    const adapter = geminiAdapter({ client })
    // Use a synthetic descriptor with nativeStructuredOutput: false to test the
    // skip-native-schema path. The real gemma-4-26b-a4b-it now has
    // nativeStructuredOutput: true (verified against the live API).
    const syntheticNoNativeOutput = makeGoogleDescriptor({
      model: 'gemma-4-26b-a4b-it',
      capabilities: {
        structuredOutput: true,
        nativeStructuredOutput: false,
        vision: true,
        sampling: 'tunable' as const,
        serviceTiers: ['flex', 'standard'] as ['flex', 'standard'],
      },
    })

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemma-4-26b-a4b-it',
        modelDescriptor: syntheticNoNativeOutput,
        outputJsonSchema: { type: 'object', additionalProperties: true },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { responseMimeType?: string; responseSchema?: unknown }
    }
    expect(call?.config?.responseMimeType).toBeUndefined()
    expect(call?.config?.responseSchema).toBeUndefined()
    expect(result.rawStructured).toEqual({ pass: true })
  })

  it('parses JSON text into rawStructured', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"name":"Bob"}' }),
    )
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', additionalProperties: true },
      }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toEqual({ name: 'Bob' })
  })

  it('leaves rawStructured undefined on JSON parse failure', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: 'not-json' }))
    const adapter = geminiAdapter({ client })

    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', additionalProperties: true },
      }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 6. FinishReason mapping
// ---------------------------------------------------------------------------

describe('finishReason mapping', () => {
  it.each([
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['BLOCKLIST', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['OTHER', 'other'],
    ['UNKNOWN_REASON', 'other'],
  ] as const)('maps %s → %s', async (sdkReason, expectedReason) => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', finishReason: sdkReason }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.finishReason).toBe(expectedReason)
  })
})

// ---------------------------------------------------------------------------
// 7. Blocked responses
// ---------------------------------------------------------------------------

describe('blocked responses', () => {
  it('throws LlmError content_filter when promptFeedback.blockReason is set', async () => {
    const client = makeFakeGemini(fakeGeminiBlocked({ blockReason: 'SAFETY' }))
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'content_filter',
      retryable: false,
      provider: 'google',
    })
  })

  it('throws LlmError content_filter for PROHIBITED_CONTENT block', async () => {
    const client = makeFakeGemini(
      fakeGeminiBlocked({ blockReason: 'PROHIBITED_CONTENT' }),
    )
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toThrow(LlmError)
  })

  it('treats an empty candidate list without blockReason as retryable', async () => {
    // Response with empty candidates and no promptFeedback
    const client = makeFakeGemini({
      candidates: [],
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('server')
    expect((err as LlmError).retryable).toBe(true)
  })

  it('preserves metered usage when candidates are undefined', async () => {
    const client = makeFakeGemini({
      usageMetadata: { promptTokenCount: 10 },
    })
    const adapter = geminiAdapter({ client })

    await expect(adapter.run(makeResolvedReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
      usage: { inputTokens: 10, outputTokens: 0 },
    })
  })
})

// ---------------------------------------------------------------------------
// 8. Error injection / classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('rethrows {status:429} as LlmError rate_limited retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 429 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.kind).toBe('rate_limited')
    expect(llmErr.retryable).toBe(true)
    expect(llmErr.provider).toBe('google')
  })

  it('rethrows {status:401} as LlmError invalid_auth not retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 401 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.kind).toBe('invalid_auth')
    expect(llmErr.retryable).toBe(false)
    expect(llmErr.provider).toBe('google')
  })

  it('rethrows {status:500} as LlmError server retryable', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 500 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('server')
    expect((err as LlmError).retryable).toBe(true)
  })

  it('rethrows {status:403} as LlmError invalid_auth', async () => {
    const client = makeFakeGemini(() => {
      throw { status: 403 }
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect((err as LlmError).kind).toBe('invalid_auth')
  })

  it('passes through provider tag on all errors', async () => {
    for (const status of [429, 401, 500]) {
      const client = makeFakeGemini(() => {
        throw { status }
      })
      const adapter = geminiAdapter({ client })
      const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
      expect((err as LlmError).provider).toBe('google')
    }
  })

  it('client construction failure → LlmError not raw Error (fix: constructor inside try/catch)', async () => {
    // Simulate buildGoogleClient throwing (e.g. bad credentials, missing SDK)
    // by injecting a _clientFactory that throws a raw Error.
    const adapter = geminiAdapter({
      _clientFactory: () => {
        throw new Error('auth init failed')
      },
    })
    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    // Must be a typed LlmError, not a raw Error.
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).provider).toBe('google')
  })

  it('rethrows an undici "fetch failed" TypeError as retryable server, not unknown', async () => {
    const client = makeFakeGemini(() => {
      throw new TypeError('fetch failed')
    })
    const adapter = geminiAdapter({ client })

    const err = await adapter.run(makeResolvedReq(), FAKE_CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    const llmErr = err as LlmError
    expect(llmErr.kind).toBe('server')
    expect(llmErr.retryable).toBe(true)
    expect(llmErr.provider).toBe('google')
  })
})

// ---------------------------------------------------------------------------
// 9. providerOptions.google lockdown
// ---------------------------------------------------------------------------

describe('providerOptions.google lockdown', () => {
  it('rejects unsupported providerOptions.google keys instead of treating them as SDK passthrough', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: { candidateCount: 2, seed: 42 },
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it.each([
    ['serviceTier', { serviceTier: 'standard' }],
    ['thinkingConfig', { thinkingConfig: { thinkingBudget: 1024 } }],
    ['responseMimeType', { responseMimeType: 'application/json' }],
    ['responseSchema', { responseSchema: { type: 'object' } }],
    ['_responseJsonSchema', { _responseJsonSchema: { type: 'object' } }],
    ['responseJsonSchema', { responseJsonSchema: { type: 'object' } }],
    ['responseFormat', { responseFormat: { text: { mimeType: 'application/json' } } }],
    ['temperature', { temperature: 0.7 }],
    ['topP', { topP: 0.8 }],
    ['topK', { topK: 40 }],
    ['mediaResolution', { mediaResolution: 'MEDIA_RESOLUTION_HIGH' }],
    ['speechConfig', { speechConfig: {} }],
    ['imageConfig', { imageConfig: {} }],
    ['responseModalities', { responseModalities: ['TEXT'] }],
  ])('rejects reserved key %s in providerOptions.google', async (_key, googleOptions) => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!

    await expect(
      adapter.run(
        makeResolvedReq({
          modelDescriptor: descriptor,
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: googleOptions,
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('passes Gemini safetySettings through providerOptions.google', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    const safetySettings = [
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_MEDIUM_AND_ABOVE',
      },
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_ONLY_HIGH',
      },
    ]

    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: { safetySettings },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { safetySettings?: unknown } }
    expect(call?.config?.safetySettings).toEqual(safetySettings)
  })

  it('rejects malformed safetySettings instead of forwarding raw SDK shapes', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: {
                safetySettings: [
                  {
                    category: 'HARM_CATEGORY_HATE_SPEECH',
                    threshold: 'BLOCK_MEDIUM_AND_ABOVE',
                    method: 'SDK_ONLY',
                  },
                ],
              },
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('passes cachedContent through providerOptions.google', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          providerOptions: {
            google: { cachedContent: 'cachedContents/abc123' },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { cachedContent?: string } }
    expect(call?.config?.cachedContent).toBe('cachedContents/abc123')
  })
})

// ---------------------------------------------------------------------------
// 10. modelVersion and responseId passthrough
// ---------------------------------------------------------------------------

describe('modelVersion and responseId', () => {
  it('passes modelVersion from response', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', modelVersion: 'gemini-2.5-pro-001' }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.modelVersion).toBe('gemini-2.5-pro-001')
  })

  it('passes responseId from response', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', responseId: 'resp-abc-123' }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.responseId).toBe('resp-abc-123')
  })
})

// ---------------------------------------------------------------------------
// 11. System instruction mapping
// ---------------------------------------------------------------------------

describe('system instruction', () => {
  it('sets systemInstruction in config when req.system is present', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ system: 'You are a helpful assistant.' }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { systemInstruction?: { parts: Array<{ text: string }> } }
    }
    expect(call?.config?.systemInstruction?.parts[0]?.text).toBe(
      'You are a helpful assistant.',
    )
  })
})

// ---------------------------------------------------------------------------
// 12. Message role mapping
// ---------------------------------------------------------------------------

describe('message role mapping', () => {
  it('maps assistant role to "model" for Gemini', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hello' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hi there' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'How are you?' }] },
        ],
        config: { serviceTier: 'flex' },
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
      },
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
    }
    expect(call?.contents[1]?.role).toBe('model')
    expect(call?.contents[0]?.role).toBe('user')
    expect(call?.contents[2]?.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// 13. AbortSignal passthrough
// ---------------------------------------------------------------------------

describe('AbortSignal passthrough', () => {
  it('passes the signal to config.abortSignal unchanged on the standard-tier path', async () => {
    // Standard default timeout composes its own timeout signal with the caller signal.
    const controller = new AbortController()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ signal: controller.signal, config: { serviceTier: 'standard' } }),
      { ...FAKE_CTX, signal: controller.signal },
    )

    const call = client.calls[0] as { config?: { abortSignal?: AbortSignal } }
    expect(call?.config?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(call?.config?.abortSignal).not.toBe(controller.signal)
  })

  it('passes the signal to config.abortSignal unchanged when timeoutMs is set (engine handles timer)', async () => {
    const controller = new AbortController()
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        signal: controller.signal,
        config: { serviceTier: 'flex', timeoutMs: 60_000 },
      }),
      { ...FAKE_CTX, signal: controller.signal },
    )

    const call = client.calls[0] as { config?: { abortSignal?: AbortSignal } }
    expect(call?.config?.abortSignal).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// 14. Full-stack integration test (no network)
// ---------------------------------------------------------------------------

describe('full-stack integration', () => {
  it('end-to-end: generate structured call → correct usage + cost + record', async () => {
    // Script the fake client to return a response with thought tokens
    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        structuredJson: JSON.stringify({ answer: 'Paris', confidence: 0.99 }),
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        cachedContentTokenCount: 20,
        totalTokenCount: 180,
        finishReason: 'STOP',
        modelVersion: 'gemini-2.5-pro-001',
        responseId: 'integration-resp-1',
      }),
    )

    const sink = new RecordingSink()
    const clock = new FakeClock(1000) // start at 1000ms
    const ids = new FakeIds()

    const client = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
      clock,
      ids,
    })

    // Advance clock so latency > 0
    clock.advance(150)

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: 'What is the capital of France?' }],
          },
        ],
        output: { jsonSchema: { type: 'object', additionalProperties: true } },
        config: {
          serviceTier: 'flex',
          reasoning: { includeThoughts: true, budgetTokens: 4096 },
        },
      },
      { auth: { apiKey: 'test-integration-key' } },
    )

    // Validate the result
    expect(result.output).toEqual({ answer: 'Paris', confidence: 0.99 })
    expect(result.modelVersion).toBe('gemini-2.5-pro-001')
    expect(result.responseId).toBe('integration-resp-1')
    expect(result.finishReason).toBe('stop')

    // #1 rule: outputTokens = candidates + thoughts
    expect(result.usage.outputTokens).toBe(80) // 50 + 30
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.thinkingTokens).toBe(30)
    expect(result.usage.cachedInputTokens).toBe(20)

    // Cost should be present (gemini-2.5-pro is in the pricing table)
    expect(result.cost).toBeDefined()
    expect(result.cost?.microUsd).not.toBeNull()

    // Sink should have received the record
    expect(sink.records).toHaveLength(1)
    const record = sink.last()!

    expect(record.status).toBe('ok')
    expect(record.callId).toBe('call_1')
    expect(record.attemptId).toBe('attempt_1')
    expect(record.provider).toBe('google')
    expect(record.model).toBe('gemini-2.5-pro')
    expect(record.modelVersion).toBe('gemini-2.5-pro-001')
    expect(record.responseId).toBe('integration-resp-1')

    // Usage on record
    expect(record.outputTokens).toBe(80) // #1 rule enforced
    expect(record.inputTokens).toBe(100)
    expect(record.thinkingTokens).toBe(30)
    expect(record.cachedInputTokens).toBe(20)

    // Cost on record matches result.cost
    expect(record.costMicroUsd).toBe(result.cost?.microUsd)
    expect(record.pricingVersion).toBe(result.cost?.pricingVersion)

    // Service tier on record
    expect(record.serviceTier).toBe('flex')
  })

  it('end-to-end: blocked response → LlmError content_filter, error record persisted', async () => {
    const fakeClient = makeFakeGemini(fakeGeminiBlocked({ blockReason: 'SAFETY' }))
    const sink = new RecordingSink()

    const client = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
    })

    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Bad prompt' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'content_filter' })

    // Error record should still be persisted (fail-closed call, fail-open sink)
    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.status).toBe('content_filter')
  })

  it('records billed usage and cost for a candidate-less HTTP 200', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [],
      usageMetadata: {
        promptTokenCount: 25,
        thoughtsTokenCount: 113,
        totalTokenCount: 138,
        serviceTier: 'flex',
      },
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
    })

    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-3.8-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Return JSON' }] }],
          config: { serviceTier: 'flex' },
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'server', retryable: true })

    const record = sink.last()!
    expect(record.status).toBe('api_error')
    expect(record.inputTokens).toBe(25)
    expect(record.outputTokens).toBe(113)
    expect(record.thinkingTokens).toBe(113)
    expect(record.servedServiceTier).toBe('flex')
    expect(record.costMicroUsd).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Standard Schema — non-Zod vendor path
// ---------------------------------------------------------------------------

describe('JSON Schema structured output', () => {
  it('does not emit schema-conversion warnings', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: JSON.stringify({ name: 'Alice' }) }),
    )

    const adapter = geminiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', additionalProperties: true },
      }),
      FAKE_CTX,
    )

    // No warning emitted — JSON Schema is forwarded directly.
    const schemaWarning = result.warnings.find(
      (w) =>
        w.type === 'other' &&
        'message' in w &&
        (w as { message: string }).message.includes('valibot'),
    )
    expect(schemaWarning).toBeUndefined()

    // rawStructured should still be populated (adapter still parses JSON).
    expect(result.rawStructured).toEqual({ name: 'Alice' })
  })

  it('engine returns parsed output without client-side schema validation', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: JSON.stringify({ name: 'Bob' }) }),
    )

    const llmClient = createClient({
      adapters: [geminiAdapter({ client })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
    })

    const result = await llmClient.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
        output: { jsonSchema: { type: 'object', additionalProperties: true } },
      },
      { auth: { apiKey: 'test-key' } },
    )

    expect(result.output).toEqual({ name: 'Bob' })
    expect(result.outputParsed).toBe(true)
  })

  it('engine does not throw when parsed output mismatches the JSON Schema hint', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: JSON.stringify({ wrong: 'field' }) }),
    )

    const llmClient = createClient({
      adapters: [geminiAdapter({ client })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
    })

    const result = await llmClient.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Name?' }] }],
        output: { jsonSchema: { type: 'object', additionalProperties: true } },
      },
      { auth: { apiKey: 'test-key' } },
    )

    expect(result.output).toEqual({ wrong: 'field' })
    expect(result.outputParsed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 16. Multimodal part mapping
// ---------------------------------------------------------------------------

describe('multimodal part mapping', () => {
  /** Extract the contents array from a captured fake-client call. */
  function getContents(call: unknown): Array<{ role: string; parts: unknown[] }> {
    return (call as { contents: Array<{ role: string; parts: unknown[] }> }).contents
  }

  it('maps a text part to { text }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ text: 'hello' }])
  })

  it('maps an inline-media part to { inlineData: { mimeType, data } }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'base64abc' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'base64abc' } }])
  })

  it('maps a file-uri part to { fileData: { mimeType, fileUri } }', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'file-uri',
                uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
                mimeType: 'video/mp4',
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([
      {
        fileData: {
          mimeType: 'video/mp4',
          fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
        },
      },
    ])
  })

  it('rejects file-ref parts (Gemini uses FileUriPart, not bare file ids)', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'file-ref', fileId: 'file_abc123' }],
            },
          ],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', provider: 'google' })
  })

  it('preserves mixed part order in one message', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'describe this image:' },
              { kind: 'inline-media', mimeType: 'image/jpeg', data: 'b64data' },
              {
                kind: 'file-uri',
                uri: 'gs://bucket/file.mp4',
                mimeType: 'video/mp4',
              },
              { kind: 'text', text: 'and this video' },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([
      { text: 'describe this image:' },
      { inlineData: { mimeType: 'image/jpeg', data: 'b64data' } },
      { fileData: { mimeType: 'video/mp4', fileUri: 'gs://bucket/file.mp4' } },
      { text: 'and this video' },
    ])
  })

  it.each([
    ['low', 'MEDIA_RESOLUTION_LOW'],
    ['medium', 'MEDIA_RESOLUTION_MEDIUM'],
    ['high', 'MEDIA_RESOLUTION_HIGH'],
  ] as const)(
    'maps inline-media mediaResolution %s → %s on the emitted part',
    async (level, expected) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      const adapter = geminiAdapter({ client })

      await adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'inline-media',
                  mimeType: 'image/png',
                  data: 'abc',
                  mediaResolution: level,
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      )

      const parts = getContents(client.calls[0])[0]!.parts
      expect(parts[0]).toMatchObject({ mediaResolution: { level: expected } })
    },
  )

  it.each([
    ['low', 'MEDIA_RESOLUTION_LOW'],
    ['medium', 'MEDIA_RESOLUTION_MEDIUM'],
    ['high', 'MEDIA_RESOLUTION_HIGH'],
  ] as const)(
    'maps file-uri mediaResolution %s → %s on the emitted part',
    async (level, expected) => {
      const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      const adapter = geminiAdapter({ client })

      await adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  uri: 'gs://bucket/file.mp4',
                  mimeType: 'video/mp4',
                  mediaResolution: level,
                },
              ],
            },
          ],
        }),
        FAKE_CTX,
      )

      const parts = getContents(client.calls[0])[0]!.parts
      expect(parts[0]).toMatchObject({ mediaResolution: { level: expected } })
    },
  )

  it('does not emit warning when mediaResolution is absent', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'abc' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'abc' } }])
    expect(parts[0]).not.toHaveProperty('mediaResolution')
  })

  it('omits mediaResolution when unset on file-uri', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'file-uri', uri: 'gs://b/f', mimeType: 'image/jpeg' }],
          },
        ],
      }),
      FAKE_CTX,
    )

    const parts = getContents(client.calls[0])[0]!.parts
    expect(parts).toEqual([{ fileData: { mimeType: 'image/jpeg', fileUri: 'gs://b/f' } }])
    expect(parts[0]).not.toHaveProperty('mediaResolution')
  })
})

// ---------------------------------------------------------------------------
// 17. Transport timeout (httpOptions.timeout)
// ---------------------------------------------------------------------------

describe('transport timeout (httpOptions.timeout)', () => {
  it('sets httpOptions.timeout to timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS when timeoutMs is set', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 1_200_000 } }),
      FAKE_CTX,
    )

    // Engine AbortSignal fires at 1_200_000 ms; transport sits 5 s above it.
    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(1_205_000)
  })

  it('sets httpOptions.timeout to FLEX_DEFAULT_TIMEOUT_MS (1_500_000) when serviceTier is flex and no timeoutMs', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(1_500_000)
  })

  it('sets STANDARD_DEFAULT_TIMEOUT_MS when serviceTier is standard and no timeoutMs', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(makeResolvedReq({ config: { serviceTier: 'standard' } }), FAKE_CTX)

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(300_000)
  })

  it('uses timeoutMs + buffer (not FLEX_DEFAULT) when both timeoutMs and flex are set', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 300_000 } }),
      FAKE_CTX,
    )

    const call = client.calls[0] as { config?: { httpOptions?: { timeout?: number } } }
    expect(call?.config?.httpOptions?.timeout).toBe(305_000)
  })

  it('caller-supplied httpOptions.timeout wins over computed timeout', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    // The adapter computes timeoutMs + buffer = 1_205_000, but caller's 42 wins.
    await adapter.run(
      makeResolvedReq({
        config: {
          serviceTier: 'flex',
          timeoutMs: 1_200_000,
          providerOptions: {
            google: {
              httpOptions: { timeout: 42 },
            },
          },
        },
      }),
      FAKE_CTX,
    )

    const call = client.calls[0] as {
      config?: { httpOptions?: { timeout?: number } }
    }
    expect(call?.config?.httpOptions?.timeout).toBe(42)
  })

  it('rejects unsupported httpOptions keys instead of preserving SDK passthrough', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: {
                httpOptions: { timeout: 42, someOtherField: 'x' },
              },
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })
})

// ---------------------------------------------------------------------------
// 18. Grounding — model-aware tool guard
// ---------------------------------------------------------------------------

describe('grounding — model-aware tool guard', () => {
  it.each([
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
  ])('allows googleSearch on %s with its descriptor', async (model) => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        model,
        modelDescriptor: defaultGeminiRegistry.resolve('google', model)!,
        config: { providerOptions: { google: { tools: [{ googleSearch: {} }] } } },
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { config?: { tools?: unknown[] } }
    expect(call.config?.tools).toEqual([{ googleSearch: {} }])
  })

  it('rejects a direct adapter request without a descriptor', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini(fakeGeminiResponse({ text: 'ok' })),
    })
    const request = makeResolvedReq()
    delete request.modelDescriptor
    await expect(adapter.run(request, FAKE_CTX)).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
  })

  it('rejects a descriptor for another model before sending the request', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'gemini-2.5-pro',
          modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-3.8-flash')!,
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })

  const GEMINI_3_MODELS = [
    'gemini-3.1-pro-preview',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ]

  it.each(GEMINI_3_MODELS)(
    'rejects structured output + googleSearch on %s with the two-call recipe, before dispatch',
    async (model) => {
      const client = makeFakeGemini(
        fakeGeminiResponse({ structuredJson: '{"winner":"Spain"}' }),
      )
      const adapter = geminiAdapter({ client })
      const descriptor = geminiModelDescriptors.find((d) => d.model === model)!
      expect(descriptor.capabilities?.structuredOutputWithTools).toBe(false)

      const err = await adapter
        .run(
          makeResolvedReq({
            model,
            modelDescriptor: descriptor,
            outputJsonSchema: {
              type: 'object',
              properties: { winner: { type: 'string' } },
              required: ['winner'],
              additionalProperties: false,
            },
            config: {
              serviceTier: 'flex',
              providerOptions: { google: { tools: [{ googleSearch: {} }] } },
            },
          }),
          FAKE_CTX,
        )
        .catch((e: unknown) => e)

      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).message).toContain('docs/grounded-structured.md')
      expect((err as LlmError).message).toMatch(/two-call recipe/i)
      expect(client.calls).toHaveLength(0)
    },
  )

  it('still admits structured output + googleSearch for a descriptor that declares it', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ structuredJson: '{"winner":"Spain"}' }),
    )
    const adapter = geminiAdapter({ client })
    const base = geminiModelDescriptors.find((d) => d.model === 'gemini-3.1-pro-preview')!
    const descriptor: ModelDescriptor = {
      ...base,
      capabilities: { ...base.capabilities, structuredOutputWithTools: true },
    }

    const result = await adapter.run(
      makeResolvedReq({
        model: 'gemini-3.1-pro-preview',
        modelDescriptor: descriptor,
        outputJsonSchema: {
          type: 'object',
          properties: { winner: { type: 'string' } },
          required: ['winner'],
          additionalProperties: false,
        },
        config: {
          serviceTier: 'flex',
          providerOptions: { google: { tools: [{ googleSearch: {} }] } },
        },
      }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toEqual({ winner: 'Spain' })
    const call = client.calls[0] as {
      config?: { responseMimeType?: string; tools?: unknown[] }
    }
    expect(call?.config?.responseMimeType).toBe('application/json')
    expect(call?.config?.tools).toEqual([{ googleSearch: {} }])
  })

  it('rejects structured output + googleSearch when the descriptor does not admit it', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!
    expect(descriptor.capabilities?.structuredOutputWithTools).toBeUndefined()

    const err = await adapter
      .run(
        makeResolvedReq({
          modelDescriptor: descriptor,
          outputJsonSchema: { type: 'object', additionalProperties: true },
          config: {
            serviceTier: 'flex',
            providerOptions: { google: { tools: [{ googleSearch: {} }] } },
          },
        }),
        FAKE_CTX,
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).retryable).toBe(false)
    expect((err as LlmError).message).toMatch(/structured output with googleSearch/i)
  })

  it('rejects unsupported tool keys', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          outputJsonSchema: { type: 'object', additionalProperties: true },
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: { tools: [{ unsupportedTool: {} }] },
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('rejects googleSearch tools with non-empty config objects', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: { tools: [{ googleSearch: { dynamic: true } }] },
            } as unknown as ProviderOptions,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('rejects googleSearch tools when the model does not support grounding', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'google-no-grounding',
          modelDescriptor: makeGoogleDescriptor({
            model: 'google-no-grounding',
            capabilities: { grounding: false },
          }),
          config: {
            serviceTier: 'flex',
            providerOptions: { google: { tools: [{ googleSearch: {} }] } },
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('audit record is persisted when grounding+schema conflict throws (full-stack)', async () => {
    const fakeClient = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const sink = new RecordingSink()

    const llmClient = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
    })

    await expect(
      llmClient.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          output: { jsonSchema: { type: 'object', additionalProperties: true } },
          config: {
            providerOptions: { google: { tools: [{ googleSearch: {} }] } },
          },
        },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })

    expect(sink.records).toHaveLength(1)
    expect(sink.last()?.status).toBe('api_error')
    expect(sink.last()?.errorKind).toBe('bad_request')
  })

  it('succeeds when googleSearch tool is present WITHOUT outputJsonSchema', async () => {
    const fakeGrounding = {
      webSearchQueries: ['what is the capital of France?'],
      groundingChunks: [],
    }
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'Paris', groundingMetadata: fakeGrounding }),
    )
    const adapter = geminiAdapter({ client })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!

    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: descriptor,
        config: {
          serviceTier: 'flex',
          providerOptions: { google: { tools: [{ googleSearch: {} }] } },
        },
      }),
      FAKE_CTX,
    )

    expect(result.text).toBe('Paris')
    const meta = result.providerMetadata as { groundingMetadata?: unknown } | undefined
    expect(meta?.groundingMetadata).toEqual(fakeGrounding)
  })
})

// ---------------------------------------------------------------------------
// 19. Grounding — providerMetadata merge
// ---------------------------------------------------------------------------

describe('grounding — providerMetadata merge', () => {
  it('includes only groundingMetadata when no promptFeedback', async () => {
    const fakeGrounding = { webSearchQueries: ['q1'], groundingChunks: [] }
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'hi', groundingMetadata: fakeGrounding }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    const meta = result.providerMetadata as Record<string, unknown> | undefined
    expect(meta?.['groundingMetadata']).toEqual(fakeGrounding)
    expect(meta?.['promptFeedback']).toBeUndefined()
  })

  it('includes both promptFeedback and groundingMetadata when both are present', async () => {
    const fakeGrounding = { webSearchQueries: ['test query'] }
    const rawResp = {
      candidates: [
        {
          content: { parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
          groundingMetadata: fakeGrounding,
        },
      ],
      promptFeedback: { safetyRatings: [] as unknown[] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }
    const client = makeFakeGemini(rawResp)
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    const meta = result.providerMetadata as Record<string, unknown> | undefined
    expect(meta?.['promptFeedback']).toBeDefined()
    expect(meta?.['groundingMetadata']).toEqual(fakeGrounding)
  })

  it('omits providerMetadata entirely when neither promptFeedback nor groundingMetadata is present', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'plain' }))
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.providerMetadata).toBeUndefined()
  })

  it('grounding metadata is persisted on the record (full-stack)', async () => {
    const fakeGrounding = {
      webSearchQueries: ['capital of France'],
      groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
    }
    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        text: 'Paris',
        groundingMetadata: fakeGrounding,
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        finishReason: 'STOP',
      }),
    )
    const sink = new RecordingSink()
    const llmClient = createClient({
      adapters: [geminiAdapter({ client: fakeClient })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
    })

    const result = await llmClient.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Capital of France?' }] },
        ],
        config: { providerOptions: { google: { tools: [{ googleSearch: {} }] } } },
      },
      { auth: { apiKey: 'test-key' } },
    )

    const resultMeta = result.providerMetadata as Record<string, unknown> | undefined
    expect(resultMeta?.['groundingMetadata']).toEqual(fakeGrounding)
    expect(result.citations).toEqual([
      { url: 'https://example.com', title: 'Example', sourceName: 'Example' },
    ])

    expect(sink.records).toHaveLength(1)
    const recordMeta = sink.last()?.providerMetadata as
      Record<string, unknown> | undefined
    expect(recordMeta?.['groundingMetadata']).toEqual(fakeGrounding)
    expect(sink.last()?.citations).toEqual(result.citations)
  })

  it('omits result.citations when grounding chunks yield no usable URLs', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'plain',
        groundingMetadata: { groundingChunks: [{ web: { uri: 'javascript:alert(1)' } }] },
      }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.citations).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 20. Grounding — registry capabilities
// ---------------------------------------------------------------------------

describe('grounding — registry capabilities', () => {
  it('every Gemini model descriptor has capabilities.grounding === true', () => {
    expect(geminiModelDescriptors).toHaveLength(9)
    for (const desc of geminiModelDescriptors) {
      expect(desc.capabilities?.grounding).toBe(true)
    }
  })

  it('every Gemini model descriptor has capabilities.functionCalling === true', () => {
    for (const desc of geminiModelDescriptors) {
      expect(desc.capabilities?.functionCalling).toBe(true)
    }
  })

  it('Gemma descriptors do not advertise functionCalling', () => {
    for (const desc of gemmaModelDescriptors) {
      expect(desc.capabilities?.functionCalling).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Fixed-sampling defensive check
// ---------------------------------------------------------------------------

describe('google function calling', () => {
  it('maps tools and named toolChoice; emits toolCalls', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: '',
        parts: [{ functionCall: { name: 'get_temperature', args: { location: 'SF' } } }],
      }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: {
          ...defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        },
        tools: [
          {
            name: 'get_temperature',
            description: 'Get temperature',
            inputJsonSchema: { type: 'object' },
          },
        ],
        toolChoice: { name: 'get_temperature' },
      }),
      FAKE_CTX,
    )
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls?.[0]?.toolName).toBe('get_temperature')
    expect(result.toolCalls?.[0]?.toolCallId).toBe('call_get_temperature_1')
  })

  it('uses provider functionCall.id and keeps two same-name calls distinct', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: '',
        parts: [
          { functionCall: { id: 'fc_a', name: 'lookup', args: { q: '1' } } },
          { functionCall: { id: 'fc_b', name: 'lookup', args: { q: '2' } } },
        ],
      }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        tools: [
          { name: 'lookup', description: 'd', inputJsonSchema: { type: 'object' } },
        ],
      }),
      FAKE_CTX,
    )
    expect(result.toolCalls?.map((c) => c.toolCallId)).toEqual(['fc_a', 'fc_b'])
  })

  it('does not collide fallback with a reserved provider id', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: '',
        parts: [
          { functionCall: { id: 'call_lookup_1', name: 'lookup', args: { q: '1' } } },
          { functionCall: { name: 'lookup', args: { q: '2' } } },
        ],
      }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        tools: [
          { name: 'lookup', description: 'd', inputJsonSchema: { type: 'object' } },
        ],
      }),
      FAKE_CTX,
    )
    expect(result.toolCalls?.map((c) => c.toolCallId)).toEqual([
      'call_lookup_1',
      'call_lookup_2',
    ])
  })

  it('reserves a later provider id before allocating an earlier fallback', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: '',
        parts: [
          { functionCall: { name: 'lookup', args: { q: '1' } } },
          { functionCall: { id: 'call_lookup_1', name: 'lookup', args: { q: '2' } } },
        ],
      }),
    )
    const adapter = geminiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        tools: [
          { name: 'lookup', description: 'd', inputJsonSchema: { type: 'object' } },
        ],
      }),
      FAKE_CTX,
    )
    expect(result.toolCalls?.map((c) => c.toolCallId)).toEqual([
      'call_lookup_2',
      'call_lookup_1',
    ])
  })

  it('replays toolCallId as functionCall/functionResponse id', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: '59' }))
    const adapter = geminiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        tools: [
          {
            name: 'get_temperature',
            description: 'd',
            inputJsonSchema: { type: 'object' },
          },
        ],
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'temp?' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'fc_1',
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
                toolCallId: 'fc_1',
                toolName: 'get_temperature',
                result: { temperature: 59 },
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    const contents = (client.calls[0] as { contents: unknown }).contents
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'temp?' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc_1',
              name: 'get_temperature',
              args: { location: 'SF' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc_1',
              name: 'get_temperature',
              response: { temperature: 59 },
            },
          },
        ],
      },
    ])
  })

  it.each([
    ['auto', { mode: 'AUTO' }],
    ['required', { mode: 'ANY' }],
    ['none', { mode: 'NONE' }],
  ] as const)('maps toolChoice %s', async (choice, expected) => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
        tools: [{ name: 'f', description: 'd', inputJsonSchema: { type: 'object' } }],
        toolChoice: choice,
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as {
      config?: { toolConfig?: { functionCallingConfig?: unknown } }
    }
    expect(call.config?.toolConfig?.functionCallingConfig).toEqual(expected)
  })

  it('rejects tools when functionCalling is not admitted', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini(fakeGeminiResponse({ text: 'x' })),
    })
    await expect(
      adapter.run(
        makeResolvedReq({
          tools: [{ name: 'f', description: 'd', inputJsonSchema: { type: 'object' } }],
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-2.5-pro',
            capabilities: { serviceTiers: ['flex', 'standard'], functionCalling: false },
          }),
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects mixing LlmRequest.tools with googleSearch', async () => {
    const adapter = geminiAdapter({
      client: makeFakeGemini(fakeGeminiResponse({ text: 'x' })),
    })
    await expect(
      adapter.run(
        makeResolvedReq({
          modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
          tools: [{ name: 'f', description: 'd', inputJsonSchema: { type: 'object' } }],
          config: { providerOptions: { google: { tools: [{ googleSearch: {} }] } } },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('fixed-sampling defensive check', () => {
  it('throws LlmError bad_request when providerOptions.google supplies sampling params for a fixed-sampling model', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        {
          provider: 'google',
          model: 'gemini-3.1-flash-lite',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: { temperature: 0.9, topP: 0.8, topK: 40 },
            } as unknown as ProviderOptions,
          },
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-3.1-flash-lite',
            pricingFamily: 'gemini-3.1-flash-lite',
            capabilities: {
              reasoning: true,
              structuredOutput: true,
              reasoningApi: 'level',
              sampling: 'fixed',
              serviceTiers: ['flex', 'standard'],
            },
          }),
        },
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('rejects providerOptions.google sampling params even on tunable-sampling models', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const adapter = geminiAdapter({ client })

    await expect(
      adapter.run(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: {
            serviceTier: 'flex',
            providerOptions: {
              google: { temperature: 0.7 },
            } as unknown as ProviderOptions,
          },
          modelDescriptor: makeGoogleDescriptor({
            model: 'gemini-2.5-pro',
            pricingFamily: 'gemini-2.5-pro',
            capabilities: {
              reasoning: true,
              structuredOutput: true,
              reasoningApi: 'budget',
              sampling: 'tunable',
              serviceTiers: ['flex', 'standard'],
            },
          }),
        },
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
  })
})

// ---------------------------------------------------------------------------
// FIX A-2. Client-side AbortSignal for flex default timeout
// ---------------------------------------------------------------------------

describe('FIX A-2: client-side flex AbortSignal ceiling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts a hanging flex call at FLEX_DEFAULT_TIMEOUT_MS when no timeoutMs is set', async () => {
    vi.useFakeTimers()

    // A client that hangs until the AbortSignal fires.
    const hangingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          return new Promise<GeminiResponseShape>((_resolve, reject) => {
            const sig = params.config?.abortSignal
            if (sig?.aborted === true) {
              reject(sig.reason)
              return
            }
            sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
          })
        },
        countTokens() {
          return Promise.resolve({ totalTokens: 0 })
        },
      },
    }

    const adapter = geminiAdapter({ client: hangingClient })

    // No timeoutMs — engine arms no AbortSignal; adapter must arm a client-side timer.
    // Attach .catch() BEFORE advancing timers so the rejection is never unhandled.
    const errPromise = adapter
      .run(makeResolvedReq({ config: { serviceTier: 'flex' } }), FAKE_CTX)
      .catch((e: unknown) => e)

    // Advance fake timers past FLEX_DEFAULT_TIMEOUT_MS — triggers the adapter's setTimeout.
    await vi.advanceTimersByTimeAsync(FLEX_DEFAULT_TIMEOUT_MS + 1)

    const err = await errPromise
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
  })

  it('does NOT arm the flex timer when timeoutMs is set (engine handles that path)', async () => {
    vi.useFakeTimers()

    // Track whether abortSignal is set and what type it is.
    let capturedSignal: AbortSignal | undefined

    const capturingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          capturedSignal = params.config?.abortSignal
          // Resolve immediately — we just want to inspect the config.
          return Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
            usageMetadata: {},
          })
        },
        countTokens() {
          return Promise.resolve({ totalTokens: 0 })
        },
      },
    }

    const engineController = new AbortController()
    const adapter = geminiAdapter({ client: capturingClient })

    await adapter.run(
      makeResolvedReq({ config: { serviceTier: 'flex', timeoutMs: 60_000 } }),
      { ...FAKE_CTX, signal: engineController.signal },
    )

    // When timeoutMs is set, we pass ctx.signal through (engine handles the deadline).
    // The captured signal should BE the engine signal, not a combined one.
    expect(capturedSignal).toBe(engineController.signal)
  })

  it('combines the flex timer with the incoming caller signal', async () => {
    vi.useFakeTimers()

    let capturedSignal: AbortSignal | undefined

    const capturingClient: GeminiClientLike = {
      models: {
        generateContent(params): Promise<GeminiResponseShape> {
          capturedSignal = params.config?.abortSignal
          // Hang — we'll abort via the caller signal.
          return new Promise<GeminiResponseShape>((_resolve, reject) => {
            const sig = params.config?.abortSignal
            if (sig?.aborted === true) {
              reject(sig.reason)
              return
            }
            sig?.addEventListener('abort', () => reject(sig.reason), { once: true })
          })
        },
        countTokens() {
          return Promise.resolve({ totalTokens: 0 })
        },
      },
    }

    const callerController = new AbortController()
    const adapter = geminiAdapter({ client: capturingClient })

    // Attach .catch() BEFORE advancing timers so the rejection is never unhandled.
    const errPromise = adapter
      .run(makeResolvedReq({ config: { serviceTier: 'flex' } }), {
        ...FAKE_CTX,
        signal: callerController.signal,
      })
      .catch((e: unknown) => e)

    // Abort via caller signal (before the flex timer fires).
    callerController.abort(new DOMException('caller cancelled', 'AbortError'))
    await vi.advanceTimersByTimeAsync(1)

    const err = await errPromise
    expect(err).toBeInstanceOf(LlmError)
    // Caller-triggered abort → kind:'aborted'
    expect((err as LlmError).kind).toBe('aborted')

    // Confirm a combined signal was passed (not the raw callerController signal).
    expect(capturedSignal).not.toBe(callerController.signal)
    expect(capturedSignal?.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Declared model aliases (ADR-033)
// ---------------------------------------------------------------------------

describe('declared model aliases', () => {
  const canonical = geminiModelDescriptors.find((d) => d.model === 'gemini-2.5-pro')!
  const aliased: ModelDescriptor = { ...canonical, aliases: ['gemini-2.5-pro-001'] }

  it('accepts a declared alias on a first-turn dispatch and sends it to the SDK verbatim', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await geminiAdapter({ client }).run(
      makeResolvedReq({ model: 'gemini-2.5-pro-001', modelDescriptor: aliased }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { model: string }).model).toBe('gemini-2.5-pro-001')
  })

  it('rejects a string that is neither the canonical id nor a declared alias', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    await expect(
      geminiAdapter({ client }).run(
        makeResolvedReq({ model: 'gemini-2.5-pro-002', modelDescriptor: aliased }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('rejects another provider’s descriptor whose alias list matches the requested string', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
    const foreign = makeTestDescriptor({
      provider: 'xai',
      model: 'grok-4.5',
      aliases: ['gemini-2.5-pro-001'],
    })
    await expect(
      geminiAdapter({ client }).run(
        makeResolvedReq({ model: 'gemini-2.5-pro-001', modelDescriptor: foreign }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(client.calls).toHaveLength(0)
  })

  it('through createClient: dispatches the alias verbatim and prices it under the canonical descriptor', async () => {
    const client = makeFakeGemini(
      fakeGeminiResponse({ text: 'ok', promptTokenCount: 100, candidatesTokenCount: 10 }),
    )
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [geminiAdapter({ client })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: createModelRegistry([aliased]),
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    const request = {
      provider: 'google',
      model: 'gemini-2.5-pro-001',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
      ],
    }

    await llm.generate(request, { auth: { apiKey: 'test-key' } })
    const viaCanonical = await llm.generate(
      { ...request, model: 'gemini-2.5-pro' },
      { auth: { apiKey: 'test-key' } },
    )

    expect((client.calls[0] as { model: string }).model).toBe('gemini-2.5-pro-001')
    expect(sink.records[0]!.model).toBe('gemini-2.5-pro-001')
    expect(sink.records[0]!.costMicroUsd).toBeGreaterThan(0)
    expect(sink.records[0]!.costMicroUsd).toBe(viaCanonical.cost?.microUsd)

    await expect(
      llm.generate(
        { ...request, model: 'gemini-2.5-pro-002' },
        { auth: { apiKey: 'test-key' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('middleware cannot reroute on the built-in registry (ADR-037)', () => {
  it('a swapped modelDescriptor and post-next provider/model assignments change neither the SDK model nor the price', async () => {
    const flash = defaultGeminiRegistry.resolve('google', 'gemini-2.5-flash')!
    const client = makeFakeGemini(
      fakeGeminiResponse({
        text: 'ok',
        promptTokenCount: 1000,
        candidatesTokenCount: 10,
      }),
    )
    const sink = new RecordingSink()
    const llm = createClient({
      adapters: [geminiAdapter({ client })],
      pricingSources: { google: geminiPricingSource() },
      modelRegistry: defaultGeminiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        {
          id: 'swapper',
          async intercept(req, ctx, next) {
            ;(req as { modelDescriptor?: ModelDescriptor }).modelDescriptor = flash
            const out = await next(req, ctx)
            ;(req as { model: string }).model = 'gemini-2.5-flash'
            return out
          },
        },
      ],
    })
    const request = {
      provider: 'google',
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
      ],
    }

    const out = await llm.generate(request, { auth: { apiKey: 'test-key' } })
    const baseline = geminiPricingSource().price('gemini-2.5-pro', out.usage)

    expect((client.calls[0] as { model: string }).model).toBe('gemini-2.5-pro')
    expect(out.cost?.microUsd).toBe(baseline.microUsd)
    expect(sink.records[0]!.model).toBe('gemini-2.5-pro')
  })
})
