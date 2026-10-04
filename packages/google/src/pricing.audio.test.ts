/**
 * Gemini input priced by `promptTokensDetails[].modality`.
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
import { geminiPricingSource, promptLanes } from './cost.js'
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

describe('audio cost confidence: one predicate for the estimate and the warning', () => {
  it('audio sent and the response reports zero audio tokens is estimated, like an absent split', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        details: { audio_input_requested: 1, input_audio: 0, input_text: 10_000 },
      }),
    )
    expect(cost.confidence).toBe('estimated')
  })

  it('a text cache beside audio in the new part of the prompt is known and exact', () => {
    // 10,000 input of which 3,000 audio (new); 5,000 cached, all text.
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: {
          audio_input_requested: 1,
          input_audio: 3_000,
          input_text: 7_000,
          cached_text: 5_000,
          cached_audio: 0,
        },
      }),
    )
    // audio 3,000 * 1.00 + uncached text 2,000 * 0.30 + cached text 5,000 * 0.03
    expect(cost.microUsd).toBe(3_000 + 600 + 150)
    expect(cost.confidence).toBe('exact')
  })

  it('cached tokens with no modality split at all cannot rule out audio in the cache: estimated', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({ inputTokens: 10_000, cachedInputTokens: 5_000 }),
    )
    expect(cost.confidence).toBe('estimated')
  })

  it('cached tokens beside a prompt split that shows no audio is exact (the cache is part of the prompt)', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { input_text: 10_000 },
      }),
    )
    expect(cost.confidence).toBe('exact')
  })

  it('a model with one rate for every modality is exact with cached tokens and no split', () => {
    expect(
      pricing.price(
        'gemini-3.8-flash',
        usage({ inputTokens: 10_000, cachedInputTokens: 5_000 }),
      ).confidence,
    ).toBe('exact')
  })
})

describe('cached audio without a prompt split, and the shapes around it', () => {
  // 2.5 Flash standard: text $0.30/M (cached $0.03), audio $1.00/M (cached $0.10).
  it('5,000 uncached text + 5,000 cached audio, no promptTokensDetails: 2,000 µUSD', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { cached_audio: 5_000 },
      }),
    )
    // uncached text 5,000 * 0.30 = 1,500; cached audio 5,000 * 0.10 = 500
    expect(cost.details).toEqual({ input: 1_500, cached: 500, output: 0, tools: 0 })
    expect(cost.microUsd).toBe(2_000)
    // The request carried no audio, so the uncached part is known audio-free.
    expect(cost.confidence).toBe('exact')
  })

  it('the same response to a request that carried audio leaves the uncached audio unknown: estimated', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { cached_audio: 5_000, audio_input_requested: 1 },
      }),
    )
    expect(cost.microUsd).toBe(2_000)
    expect(cost.confidence).toBe('estimated')
  })

  it('cached audio raises a smaller or absent prompt audio count to at least the cached audio', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { input_audio: 2_000, cached_audio: 5_000 },
      }),
    )
    expect(cost.microUsd).toBe(1_500 + 500)
    expect(cost.confidence).toBe('estimated') // the counts contradict each other
  })

  it('cached audio larger than the cache or the prompt is clamped and estimated', () => {
    const aboveCache = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 2_000,
        details: { cached_audio: 9_000 },
      }),
    )
    // 2,000 cached audio * 0.10 + 8,000 uncached text * 0.30
    expect(aboveCache.microUsd).toBe(200 + 2_400)
    expect(aboveCache.confidence).toBe('estimated')

    const aboveTotal = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 1_000,
        cachedInputTokens: 5_000,
        details: { cached_audio: 7_000 },
      }),
    )
    // cached is clamped to the prompt: 1,000 cached audio * 0.10
    expect(aboveTotal.microUsd).toBe(100)
    expect(aboveTotal.confidence).toBe('estimated')
  })

  it('uncached audio plus cached tokens that exceed the prompt is estimated, never negative', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { input_audio: 9_000, cached_audio: 0 },
      }),
    )
    expect(cost.confidence).toBe('estimated')
    expect(cost.details.input).toBeGreaterThanOrEqual(0)
    const d = cost.details
    expect(d.input + d.cached + d.output + d.tools).toBe(cost.microUsd)
  })

  it('cached text beside an audio prompt split but no cached split is unknown: estimated', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { input_audio: 3_000, input_text: 7_000, cached_text: 5_000 },
      }),
    )
    // cached_text lists no audio and covers the cache, but the adapter records
    // cached_audio: 0 for that; a hand-built usage without it is unknown.
    expect(cost.confidence).toBe('estimated')
  })

  it('a cache listing that covers fewer cached tokens than reported and names no audio is unknown', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        details: { cached_text: 3_000 },
      }),
    )
    expect(cost.confidence).toBe('estimated')
  })

  it('thinking tokens are output tokens and never touch the prompt lanes', () => {
    const cost = pricing.price(
      'gemini-2.5-flash',
      usage({
        inputTokens: 10_000,
        cachedInputTokens: 5_000,
        outputTokens: 1_500 + 500, // candidates + thoughts
        thinkingTokens: 500,
        details: { cached_audio: 5_000, thinking: 500 },
      }),
    )
    expect(cost.details).toEqual({
      input: 1_500,
      cached: 500,
      output: 5_000, // 2,000 * 2.50
      tools: 0,
    })
    expect(cost.confidence).toBe('exact')
  })
})

describe('promptLanes: random splits', () => {
  // Deterministic PRNG (mulberry32) so a failure reproduces.
  function prng(seed: number): () => number {
    let a = seed
    return () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
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

  // 2.5 Flash standard rates, µUSD per million tokens.
  const TEXT = 300_000
  const CACHED_TEXT = 30_000
  const AUDIO = 1_000_000
  const CACHED_AUDIO = 100_000
  const OUT = 2_500_000
  const lane = (tokens: number, rate: number) => Math.round((tokens * rate) / 1_000_000)

  it('the lanes sum to the prompt; the price matches the truth when the response says enough, else estimated', async () => {
    const random = prng(20261003)
    const int = (max: number) => Math.floor(random() * (max + 1))
    let exact = 0
    let estimated = 0
    for (let i = 0; i < 300; i++) {
      // The truth: a prompt of P tokens, C cached, A audio of which Ac cached.
      const P = int(2_000_000)
      const C = random() < 0.3 ? 0 : int(P)
      const Ac = random() < 0.5 ? 0 : int(C)
      const uncachedAudio = random() < 0.5 ? 0 : int(P - C)
      const A = Ac + uncachedAudio
      const candidates = int(5_000)
      const thoughts = random() < 0.5 ? 0 : int(5_000)

      const promptSplit = random() < 0.5
      const cacheSplit = C > 0 && random() < 0.5
      const promptDetails = [
        { modality: 'TEXT', tokenCount: P - A },
        // An audio entry is listed when there is audio (or sometimes as an explicit zero).
        ...(A > 0 || random() < 0.5 ? [{ modality: 'AUDIO', tokenCount: A }] : []),
      ]
      const cacheDetails = [
        { modality: 'TEXT', tokenCount: C - Ac },
        ...(Ac > 0 || random() < 0.5 ? [{ modality: 'AUDIO', tokenCount: Ac }] : []),
      ]
      const requestHasAudio = uncachedAudio > 0

      const response = fakeGeminiResponse({
        text: 'ok',
        promptTokenCount: P,
        candidatesTokenCount: candidates,
      })
      Object.assign(response.usageMetadata ?? {}, {
        ...(C > 0 ? { cachedContentTokenCount: C } : {}),
        ...(thoughts > 0 ? { thoughtsTokenCount: thoughts } : {}),
        ...(promptSplit ? { promptTokensDetails: promptDetails } : {}),
        ...(cacheSplit ? { cacheTokensDetails: cacheDetails } : {}),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [geminiAdapter({ client: makeFakeGemini(response) })],
        pricingSources: { google: pricing },
        modelRegistry: defaultGeminiRegistry,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })
      const { cost, usage: u } = await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: requestHasAudio ? audioMessage : textMessage,
        },
        { auth: AUTH },
      )

      // Enough information: the uncached audio is reported (or there is none to
      // report), and the cached audio is reported or provably absent.
      const audioReported = promptSplit && A > 0
      const uncachedKnown = !requestHasAudio || audioReported
      const cachedKnown =
        C === 0 ||
        cacheSplit ||
        (promptSplit && A === 0) /* prompt split proves no audio */
      const known = uncachedKnown && cachedKnown

      const lanes = promptLanes(u)
      expect(
        lanes.audioUncached + lanes.audioCached + lanes.otherUncached + lanes.otherCached,
        `sum #${i}`,
      ).toBe(P)

      if (known) {
        exact++
        const price =
          lane(P - C - uncachedAudio, TEXT) +
          lane(uncachedAudio, AUDIO) +
          lane(C - Ac, CACHED_TEXT) +
          lane(Ac, CACHED_AUDIO) +
          lane(candidates + thoughts, OUT)
        expect(cost?.microUsd, `price #${i}`).toBe(price)
        expect(cost?.confidence, `confidence #${i}`).toBe('exact')
        expect(lanes.gaps, `gaps #${i}`).toEqual([])
      } else {
        estimated++
        expect(cost?.confidence, `confidence #${i}`).toBe('estimated')
        expect(lanes.gaps.length, `gaps #${i}`).toBeGreaterThan(0)
      }
      const d = cost?.details
      expect(
        (d?.input ?? 0) + (d?.cached ?? 0) + (d?.output ?? 0) + (d?.tools ?? 0),
      ).toBe(cost?.microUsd)
    }
    // Both branches were exercised.
    expect(exact).toBeGreaterThan(30)
    expect(estimated).toBeGreaterThan(30)
  })

  it('lanes sum to the prompt even for contradictory counts', () => {
    const random = prng(7)
    const int = (max: number) => Math.floor(random() * (max + 1))
    for (let i = 0; i < 500; i++) {
      const P = int(100_000)
      const lanes = promptLanes(
        usage({
          inputTokens: P,
          ...(random() < 0.5 ? {} : { cachedInputTokens: int(150_000) }),
          details: {
            ...(random() < 0.6 ? { input_audio: int(150_000) } : {}),
            ...(random() < 0.6 ? { cached_audio: int(150_000) } : {}),
            ...(random() < 0.5 ? { input_text: int(150_000) } : {}),
            ...(random() < 0.5 ? { audio_input_requested: 1 } : {}),
          },
        }),
      )
      for (const tokens of [
        lanes.audioUncached,
        lanes.audioCached,
        lanes.otherUncached,
        lanes.otherCached,
      ]) {
        expect(Number.isInteger(tokens) && tokens >= 0, `non-negative #${i}`).toBe(true)
      }
      expect(
        lanes.audioUncached + lanes.audioCached + lanes.otherUncached + lanes.otherCached,
      ).toBe(P)
    }
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

  it('a cache listing only text, covering every cached token, makes cached audio provably zero', async () => {
    const { result } = await run(audioMessage, {
      cachedContentTokenCount: 5_000,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 7_000 },
        { modality: 'AUDIO', tokenCount: 3_000 },
      ],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 5_000 }],
    })
    expect(result.usage.details).toMatchObject({ cached_text: 5_000, cached_audio: 0 })
    expect(result.cost?.confidence).toBe('exact')
    expect(result.cost?.microUsd).toBe(3_000 + 600 + 150 + 1_250)
    expect(result.warnings).toEqual([])
  })

  it('a cache listing that covers fewer tokens than were cached leaves cached audio unknown', async () => {
    const { result } = await run(audioMessage, {
      cachedContentTokenCount: 5_000,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 7_000 },
        { modality: 'AUDIO', tokenCount: 3_000 },
      ],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 3_000 }],
    })
    expect(result.usage.details).not.toHaveProperty('cached_audio')
    expect(result.cost?.confidence).toBe('estimated')
  })

  it('AUDIO reported as zero warns and is estimated: the warning and the estimate agree', async () => {
    const { result } = await run(audioMessage, {
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 10_000 },
        { modality: 'AUDIO', tokenCount: 0 },
      ],
    })
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('reports no AUDIO tokens'),
    ])
  })

  it('a lower-case audio modality is read the same way (mapUsage lower-cases it)', async () => {
    const { result } = await run(audioMessage, {
      promptTokensDetails: [
        { modality: 'text', tokenCount: 6_000 },
        { modality: 'audio', tokenCount: 4_000 },
      ],
    })
    expect(result.warnings).toEqual([])
    expect(result.cost?.confidence).toBe('exact')
  })

  it('cached audio reported without a prompt split is priced at the cached audio rate', async () => {
    const { result } = await run(textMessage, {
      cachedContentTokenCount: 5_000,
      cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 5_000 }],
    })
    // 5,000 uncached text * 0.30 + 5,000 cached audio * 0.10 + 500 output * 2.50
    expect(result.cost?.details).toEqual({
      input: 1_500,
      cached: 500,
      output: 1_250,
      tools: 0,
    })
    expect(result.cost?.confidence).toBe('exact')
    expect(result.warnings).toEqual([])
  })

  it('the same response to an audio request is priced and estimated, with the warning', async () => {
    const { result } = await run(audioMessage, {
      cachedContentTokenCount: 5_000,
      cacheTokensDetails: [{ modality: 'AUDIO', tokenCount: 5_000 }],
    })
    expect(result.cost?.microUsd).toBe(1_500 + 500 + 1_250)
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('reports no AUDIO tokens'),
    ])
  })

  it('cached tokens with no modality split warn that audio in the cache cannot be ruled out', async () => {
    const { result } = await run(textMessage, {
      cachedContentTokenCount: 5_000,
    })
    expect(result.cost?.confidence).toBe('estimated')
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('without showing how many are audio'),
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
