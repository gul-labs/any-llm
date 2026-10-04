/**
 * Descriptor limits, admitted input media types, and the
 * thinking-budget warning. No network: every call goes through the fake client.
 */

import { describe, expect, it } from 'vitest'
import { createClient } from '@gullabs/core'
import type { Message } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'

import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import {
  defaultGeminiRegistry,
  gemmaModelDescriptors,
  geminiModelDescriptors,
} from './models.js'

const AUTH = { apiKey: 'test-key' }

function setup() {
  const fake = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
  const client = createClient({
    adapters: [geminiAdapter({ client: fake })],
    pricingSources: { google: geminiPricingSource() },
    modelRegistry: defaultGeminiRegistry,
    sink: new RecordingSink(),
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
  return { fake, client }
}

const media = (mimeType: string): Message[] => [
  {
    role: 'user',
    parts: [
      { kind: 'text', text: 'describe' },
      { kind: 'inline-media', mimeType, data: 'AAAA' },
    ],
  },
]
const text: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }]

describe('google descriptor limits (docs read 2026-10-03)', () => {
  it('every Gemini model states 1,048,576 context and 65,536 output', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.limits).toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536 })
    }
  })

  it('Gemma 4 states a 256K window and a null output limit (none is documented)', () => {
    for (const d of gemmaModelDescriptors) {
      expect(d.limits).toEqual({ contextWindow: 262_144, maxOutputTokens: null })
    }
  })

  it('limits objects are frozen and not shared between descriptors', () => {
    const all = [...geminiModelDescriptors, ...gemmaModelDescriptors]
    expect(new Set(all.map((d) => d.limits)).size).toBe(all.length)
    for (const d of all) {
      expect(Object.isFrozen(d.limits)).toBe(true)
      expect(Object.isFrozen(d.capabilities?.inputMimeTypes)).toBe(true)
      expect(() => {
        ;(d.limits as { maxOutputTokens: number | null }).maxOutputTokens = 5
      }).toThrow(TypeError)
    }
  })

  it('Gemma applies no maxOutputTokens cap: its provider documents none', () => {
    for (const d of gemmaModelDescriptors) {
      expect(d.configSchema.safeParse({ maxOutputTokens: 1_000_000 }).success).toBe(true)
      expect(d.configSchema.safeParse({ maxOutputTokens: 0 }).success).toBe(false)
    }
  })

  it('every Gemini config schema caps maxOutputTokens at limits.maxOutputTokens on every tier branch', () => {
    for (const d of geminiModelDescriptors) {
      const cap = d.limits.maxOutputTokens as number
      const branches: Array<Record<string, unknown>> = [{}]
      if (d.capabilities?.serviceTiers?.includes('flex') === true) {
        branches.push({ serviceTier: 'flex' })
      }
      for (const base of branches) {
        expect(
          d.configSchema.safeParse({ ...base, maxOutputTokens: cap }).success,
          `${d.model} accepts ${cap}`,
        ).toBe(true)
        expect(
          d.configSchema.safeParse({ ...base, maxOutputTokens: cap + 1 }).success,
          `${d.model} rejects ${cap + 1}`,
        ).toBe(false)
      }
    }
  })

  it('the engine rejects an over-cap maxOutputTokens before dispatch', async () => {
    const { fake, client } = setup()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-3.6-flash',
          messages: text,
          config: { maxOutputTokens: 65_537 },
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('google admitted input media types', () => {
  it('Gemini admits WebP, PDF, audio and video and sends the part unchanged', async () => {
    for (const mimeType of ['image/webp', 'application/pdf', 'audio/mp3', 'video/mp4']) {
      const { fake, client } = setup()
      await client.generate(
        { provider: 'google', model: 'gemini-3.6-flash', messages: media(mimeType) },
        { auth: AUTH },
      )
      expect(JSON.stringify(fake.calls[0])).toContain(mimeType)
    }
  })

  it('Gemini rejects a type outside every family, before dispatch, with the path', async () => {
    const { fake, client } = setup()
    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-3.6-flash',
          messages: media('application/zip'),
        },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((err as Error).message).toContain('messages[0].parts[1]')
    expect((err as Error).message).toContain('application/zip')
    expect(fake.calls).toHaveLength(0)
  })

  it('a file-uri part is checked the same way', async () => {
    const { fake, client } = setup()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-3.6-flash',
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  mimeType: 'application/zip',
                  uri: 'https://x.test/a',
                },
              ],
            },
          ],
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)
  })

  it('Gemini admits the documented families by prefix and PDF, not a closed subset', async () => {
    for (const mimeType of [
      'text/csv',
      'text/plain; charset=utf-8',
      'text/x-python',
      'image/gif',
      'audio/x-wav',
      'audio/wave',
      'video/quicktime',
      'video/x-matroska',
      'IMAGE/PNG',
      'Application/PDF',
    ]) {
      const { fake, client } = setup()
      await client.generate(
        { provider: 'google', model: 'gemini-3.6-flash', messages: media(mimeType) },
        { auth: AUTH },
      )
      // Admission reads a normalised copy; the provider gets the host's string.
      expect(JSON.stringify(fake.calls[0]), mimeType).toContain(mimeType)
    }
  })

  it('Gemini rejects what is in no documented family, and a malformed or empty type', async () => {
    for (const mimeType of [
      'application/json',
      'application/xml',
      'application/octet-stream',
      'font/woff2',
      'image/*',
      'image',
      '',
      '  ',
      '; charset=utf-8',
    ]) {
      const { fake, client } = setup()
      await expect(
        client.generate(
          { provider: 'google', model: 'gemini-3.6-flash', messages: media(mimeType) },
          { auth: AUTH },
        ),
        mimeType,
      ).rejects.toMatchObject({ kind: 'bad_request' })
      expect(fake.calls).toHaveLength(0)
    }
  })

  it('an empty media type gets its own message, not an admitted-list mismatch', async () => {
    const { client } = setup()
    const err = await client
      .generate(
        { provider: 'google', model: 'gemini-3.6-flash', messages: media('') },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)
    expect((err as Error).message).toContain('a media type is required')
    expect((err as Error).message).toContain('messages[0].parts[1]')
  })

  it('a YouTube-style file-uri takes any video type from the admitted family', async () => {
    const { fake, client } = setup()
    await client.generate(
      {
        provider: 'google',
        model: 'gemini-3.6-flash',
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'file-uri',
                mimeType: 'video/mp4',
                uri: 'https://www.youtube.com/watch?v=abc',
              },
            ],
          },
        ],
      },
      { auth: AUTH },
    )
    expect(fake.calls).toHaveLength(1)
  })

  it('Gemma admits image and video (frames) and rejects audio, PDF and text files', async () => {
    for (const mimeType of ['image/png', 'image/webp', 'video/mp4']) {
      const ok = setup()
      await ok.client.generate(
        { provider: 'google', model: 'gemma-4-31b-it', messages: media(mimeType) },
        { auth: AUTH },
      )
      expect(ok.fake.calls).toHaveLength(1)
    }

    for (const mimeType of ['audio/wav', 'application/pdf', 'text/plain']) {
      const { fake, client } = setup()
      await expect(
        client.generate(
          { provider: 'google', model: 'gemma-4-31b-it', messages: media(mimeType) },
          { auth: AUTH },
        ),
      ).rejects.toMatchObject({ kind: 'bad_request' })
      expect(fake.calls).toHaveLength(0)
    }
  })

  it('countTokens rejects an unadmitted type before the SDK is called', async () => {
    const { fake, client } = setup()
    await expect(
      client.countTokens(
        {
          provider: 'google',
          model: 'gemini-3.6-flash',
          messages: media('application/zip'),
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.countTokensCalls).toHaveLength(0)
  })
})

async function warningsForReasoning(
  model: string,
  config: Record<string, unknown>,
): Promise<string[]> {
  const { client } = setup()
  const result = await client.generate(
    { provider: 'google', model, messages: text, config },
    { auth: AUTH },
  )
  return result.warnings.map((w) => w.message).filter((m) => m.includes('thinking'))
}

describe('thinking budget at or above maxOutputTokens', () => {
  async function warningsFor(
    model: string,
    config: Record<string, unknown>,
  ): Promise<string[]> {
    const { fake, client } = setup()
    const result = await client.generate(
      { provider: 'google', model, messages: text, config },
      { auth: AUTH },
    )
    expect(fake.calls).toHaveLength(1)
    return result.warnings
      .map((w) => w.message)
      .filter((m) => m.includes('thinkingBudget'))
  }

  it('warns, without rejecting, when the effort default budget is not below the cap', async () => {
    const warnings = await warningsFor('gemini-2.5-flash', {
      maxOutputTokens: 4096,
      reasoning: { effort: 'high' },
    })
    expect(warnings).toEqual([
      'google: thinkingBudget (24576) is not below maxOutputTokens (4096); thinking may consume the whole cap and leave no answer. Raise maxOutputTokens or lower the reasoning budget.',
    ])
  })

  it('warns on an explicit budget equal to the cap, not on one below it', async () => {
    expect(
      await warningsFor('gemini-2.5-pro', {
        maxOutputTokens: 2000,
        reasoning: { budgetTokens: 2000 },
      }),
    ).toHaveLength(1)
    expect(
      await warningsFor('gemini-2.5-pro', {
        maxOutputTokens: 2000,
        reasoning: { budgetTokens: 1999 },
      }),
    ).toHaveLength(0)
  })

  it('is silent with thinking off, with no cap set, and on level models', async () => {
    expect(
      await warningsFor('gemini-2.5-flash', {
        maxOutputTokens: 100,
        reasoning: { effort: 'none' },
      }),
    ).toHaveLength(0)
    expect(
      await warningsFor('gemini-2.5-flash', { reasoning: { effort: 'high' } }),
    ).toHaveLength(0)
  })

  it('warns on a level model at high effort under 4,096, naming the measured figure', async () => {
    for (const model of [
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]) {
      const warnings = await warningsForReasoning(model, {
        maxOutputTokens: 2048,
        reasoning: { effort: 'high' },
      })
      expect(warnings, model).toHaveLength(1)
      expect(warnings[0]).toContain('maxOutputTokens is 2048')
      expect(warnings[0]).toContain('8,859')
    }
  })

  it('is silent on a level model at high with 4,096 or more, or at lower efforts, or with no cap', async () => {
    const quiet: Array<Record<string, unknown>> = [
      { maxOutputTokens: 4096, reasoning: { effort: 'high' } },
      { maxOutputTokens: 100, reasoning: { effort: 'medium' } },
      { maxOutputTokens: 100, reasoning: { effort: 'low' } },
      { maxOutputTokens: 100 },
      { reasoning: { effort: 'high' } },
    ]
    for (const config of quiet) {
      expect(await warningsForReasoning('gemini-3.6-flash', config)).toHaveLength(0)
    }
  })
})

describe('google configKeys', () => {
  it('lists the keys of every tier branch of each Gemini schema, once', () => {
    for (const d of geminiModelDescriptors) {
      expect(d.configKeys, d.model).toEqual(
        expect.arrayContaining([
          'maxOutputTokens',
          'providerOptions',
          'reasoning',
          'serviceTier',
          'stopSequences',
          'timeoutMs',
        ]),
      )
      expect(new Set(d.configKeys).size).toBe(d.configKeys.length)
      expect([...d.configKeys]).toEqual([...d.configKeys].sort())
    }
  })

  it('sampling keys appear only on models whose sampling is tunable', () => {
    for (const d of [...geminiModelDescriptors, ...gemmaModelDescriptors]) {
      const tunable = d.capabilities?.sampling === 'tunable'
      for (const key of ['temperature', 'topP', 'topK']) {
        expect(d.configKeys.includes(key), `${d.model} ${key}`).toBe(tunable)
      }
    }
  })

  it('Gemma has no serviceTier key (no tier is admitted)', () => {
    for (const d of gemmaModelDescriptors) {
      expect(d.configKeys).not.toContain('serviceTier')
    }
  })

  it('every listed key is accepted by the schema in some config', () => {
    for (const d of [...geminiModelDescriptors, ...gemmaModelDescriptors]) {
      for (const key of d.configKeys) {
        const probe: Record<string, unknown> = {
          maxOutputTokens: 10,
          stopSequences: ['x'],
          timeoutMs: 1000,
          temperature: 0.5,
          topP: 0.5,
          topK: 5,
          reasoning: { includeThoughts: true },
          providerOptions: {},
          serviceTier: 'flex',
        }
        expect(key in probe, `${d.model}: no probe for ${key}`).toBe(true)
        const accepted =
          d.configSchema.safeParse({ [key]: probe[key] }).success ||
          d.configSchema.safeParse({ serviceTier: 'flex', [key]: probe[key] }).success
        expect(accepted, `${d.model} accepts ${key}`).toBe(true)
      }
    }
  })
})
