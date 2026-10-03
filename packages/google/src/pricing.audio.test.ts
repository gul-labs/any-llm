/**
 * R7.6 — Gemini input priced by `promptTokensDetails[].modality`.
 *
 * Audio input is billed at its own rate on Gemini 2.5 Flash, 2.5 Flash-Lite and
 * 3.1 Flash-Lite (https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-03,
 * page last updated 2026-10-01). Every other model has one input rate.
 */

import { describe, expect, it } from 'vitest'
import { createClient } from '@gullabs/core'
import type { Message, Usage } from '@gullabs/core'
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
import { GEMINI_PRICED_TIERS, GEMINI_PRICING } from './pricing.js'

const pricing = geminiPricingSource()

function usage(over: Partial<Usage> & { details?: Record<string, number> }): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    raw: null,
    ...over,
    details: over.details ?? {},
  }
}

describe('audio input rates', () => {
  it('2.5 Flash standard: audio tokens at $1.00/M, the rest at $0.30/M', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        outputTokens: 500,
        details: { input_audio: 4_000, input_text: 6_000 },
      }),
    )
    expect(cost.details).toEqual({
      input: 6_000 * 0.3 + 4_000 * 1.0, // 1,800 + 4,000
      cached: 0,
      output: 1_250,
      tools: 0,
    })
    expect(cost.microUsd).toBe(5_800 + 1_250)
    expect(cost.confidence).toBe('exact')
  })

  it('cached audio is billed at the cached audio rate, cached text at the cached text rate', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: {
          input_audio: 4_000,
          input_text: 6_000,
          cached_audio: 2_000,
          cached_text: 3_000,
        },
      }),
    )
    // uncached text 3,000 * 0.30 + uncached audio 2,000 * 1.00
    // cached text 3,000 * 0.03 + cached audio 2,000 * 0.10
    expect(cost.details).toEqual({
      input: 900 + 2_000,
      cached: 90 + 200,
      output: 0,
      tools: 0,
    })
    expect(cost.confidence).toBe('exact')
  })

  it.each([
    ['gemini-2.5-flash', 'standard', 1_000_000, 100_000],
    ['gemini-2.5-flash', 'flex', 500_000, 100_000],
    ['gemini-2.5-flash-lite', 'standard', 300_000, 30_000],
    ['gemini-2.5-flash-lite', 'flex', 150_000, 30_000],
    ['gemini-3.1-flash-lite', 'standard', 500_000, 50_000],
    ['gemini-3.1-flash-lite', 'flex', 250_000, 25_000],
  ])(
    '%s %s tier: audio %i / cached audio %i µUSD per M',
    (model, tier, input, cached) => {
      const cost = pricing.price(
        model,
        usage({
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          details: { input_audio: 2_000_000, cached_audio: 1_000_000 },
        }),
        tier,
      )
      expect(cost.details.input).toBe(input) // 1M uncached audio tokens
      expect(cost.details.cached).toBe(cached) // 1M cached audio tokens
    },
  )

  it('models whose page lists one rate for all modalities ignore the audio split', () => {
    for (const model of [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-2.5-pro',
      'gemini-3.1-pro-preview',
    ]) {
      const plain = pricing.price(model, usage({ inputTokens: 10_000 }))
      const audio = pricing.price(
        model,
        usage({ inputTokens: 10_000, details: { input_audio: 10_000 } }),
      )
      expect(audio.microUsd, model).toBe(plain.microUsd)
      expect(audio.confidence, model).toBe('exact')
    }
  })

  it('no model with an audio rate has a long-context band (the audio split never needs one)', () => {
    for (const [model, tiers] of Object.entries(GEMINI_PRICING)) {
      for (const tier of GEMINI_PRICED_TIERS) {
        if (tiers[tier].audio !== undefined) {
          expect(tiers[tier].gt200k, `${model} ${tier}`).toBeUndefined()
        }
      }
    }
  })

  it('clamps audio tokens to the prompt and cached audio to cached tokens', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 1_000,
        cachedInputTokens: 100,
        details: { input_audio: 5_000, cached_audio: 900 },
      }),
    )
    // 1,000 audio tokens; 100 of them cached.
    expect(cost.details).toEqual({ input: 900, cached: 10, output: 0, tools: 0 })
  })

  it('the lanes sum to microUsd', () => {
    const cost = pricing.price(
      'gemini-3.1-flash-lite',
      usage({
        inputTokens: 12_345,
        cachedInputTokens: 3_333,
        outputTokens: 777,
        details: { input_audio: 4_321, cached_audio: 1_111 },
      }),
      'flex',
    )
    const d = cost.details
    expect(d.input + d.cached + d.output + d.tools).toBe(cost.microUsd)
  })
})

describe('the audio share can be unknown, which makes the call estimated', () => {
  it('audio was sent but the response reports no audio tokens', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({ inputTokens: 10_000, details: { audio_input_requested: 1 } }),
    )
    expect(cost.confidence).toBe('estimated')
    expect(cost.microUsd).toBe(3_000) // priced at the text rate: an understatement
  })

  it('audio was sent and reported: exact', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        details: { audio_input_requested: 1, input_audio: 10_000 },
      }),
    )
    expect(cost.confidence).toBe('exact')
  })

  it('a model with one rate for every modality stays exact', () => {
    expect(
      pricing.price(
        'gemini-3.8-flash',
        usage({ inputTokens: 10_000, details: { audio_input_requested: 1 } }),
      ).confidence,
    ).toBe('exact')
  })

  it('cached tokens beside audio with no cached split', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { input_audio: 4_000 },
      }),
    )
    expect(cost.confidence).toBe('estimated')
  })
})

describe('the dead batch tier is gone', () => {
  it('batch is not a priced tier', () => {
    expect(GEMINI_PRICED_TIERS).toEqual(['standard', 'flex'])
    const cost = pricing.price('gemini-2.5-pro', usage({ inputTokens: 1_000 }), 'batch')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/Unpriced service tier "batch"/)
    for (const tiers of Object.values(GEMINI_PRICING)) {
      expect(Object.keys(tiers).sort()).toEqual(['flex', 'standard'])
    }
  })
})

describe('adapter: promptTokensDetails reach usage.details and the cost', () => {
  const AUTH = { apiKey: 'test-key' }
  const audioMessage: Message[] = [
    {
      role: 'user',
      parts: [
        { kind: 'text', text: 'transcribe' },
        { kind: 'inline-media', mimeType: 'audio/wav', data: 'AAAA' },
      ],
    },
  ]
  const textMessage: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]

  function run(
    messages: Message[],
    usageMetadata: Record<string, unknown> | undefined,
    model = 'gemini-2.5-flash',
  ) {
    const response = fakeGeminiResponse({
      text: 'ok',
      promptTokenCount: 10_000,
      candidatesTokenCount: 500,
    })
    if (usageMetadata !== undefined)
      Object.assign(response.usageMetadata ?? {}, usageMetadata)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [geminiAdapter({ client: makeFakeGemini(response) })],
      pricingSources: { google: pricing },
      modelRegistry: defaultGeminiRegistry,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    return client
      .generate({ provider: 'google', model, messages }, { auth: AUTH })
      .then((result) => ({ result, row: sink.last() }))
  }

  it('records the per-modality counts and bills the audio tokens at the audio rate', async () => {
    const { result, row } = await run(audioMessage, {
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 6_000 },
        { modality: 'AUDIO', tokenCount: 4_000 },
      ],
      cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 0 }],
    })
    expect(result.usage.details).toMatchObject({
      input_text: 6_000,
      input_audio: 4_000,
      cached_audio: 0,
      audio_input_requested: 1,
    })
    expect(result.cost?.confidence).toBe('exact')
    expect(result.cost?.details).toEqual({
      input: 1_800 + 4_000,
      cached: 0,
      output: 1_250,
      tools: 0,
    })
    expect(result.warnings).toEqual([])
    expect(row?.costDetails).toEqual(result.cost?.details)
  })

  it('warns and estimates when the request carries audio and the response does not split the prompt', async () => {
    const { result } = await run(audioMessage, undefined)
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('reports no AUDIO tokens'),
    ])
  })

  it('a text-only request has no audio marker and no warning', async () => {
    const { result } = await run(textMessage, {
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10_000 }],
    })
    expect(result.usage.details['audio_input_requested']).toBeUndefined()
    expect(result.usage.details['input_text']).toBe(10_000)
    expect(result.cost?.confidence).toBe('exact')
    expect(result.warnings).toEqual([])
  })

  it('ignores malformed modality entries', async () => {
    const { result } = await run(textMessage, {
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 10_000 },
        { modality: 'IMAGE', tokenCount: -3 },
        { tokenCount: 4 },
        { modality: 'VIDEO' },
      ],
    })
    expect(
      Object.keys(result.usage.details).filter((k) => k.startsWith('input_')),
    ).toEqual(['input_text'])
  })
})
