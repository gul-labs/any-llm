/**
 * R3.1 / R3.2 — descriptor limits, admitted input media types, and the
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

  it('Gemma 4 states a 256K window and, with no documented output limit, the window', () => {
    for (const d of gemmaModelDescriptors) {
      expect(d.limits).toEqual({ contextWindow: 262_144, maxOutputTokens: 262_144 })
    }
  })

  it('every config schema caps maxOutputTokens at limits.maxOutputTokens on every tier branch', () => {
    for (const d of [...geminiModelDescriptors, ...gemmaModelDescriptors]) {
      const cap = d.limits.maxOutputTokens
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

  it('Gemini rejects a type Google does not document, before dispatch, with the path', async () => {
    const { fake, client } = setup()
    const err = await client
      .generate(
        { provider: 'google', model: 'gemini-3.6-flash', messages: media('image/bmp') },
        { auth: AUTH },
      )
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((err as Error).message).toContain('messages[0].parts[1]')
    expect((err as Error).message).toContain('image/bmp')
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
                { kind: 'file-uri', mimeType: 'image/bmp', uri: 'https://x.test/a' },
              ],
            },
          ],
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)
  })

  it('Gemma admits PNG and JPEG only', async () => {
    const ok = setup()
    await ok.client.generate(
      { provider: 'google', model: 'gemma-4-31b-it', messages: media('image/png') },
      { auth: AUTH },
    )
    expect(ok.fake.calls).toHaveLength(1)

    for (const mimeType of ['image/webp', 'audio/wav', 'video/mp4', 'application/pdf']) {
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

  it('matches exactly: no case folding or parameters', async () => {
    for (const mimeType of ['IMAGE/PNG', 'image/png; q=1']) {
      const { fake, client } = setup()
      await expect(
        client.generate(
          { provider: 'google', model: 'gemini-3.6-flash', messages: media(mimeType) },
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
        { provider: 'google', model: 'gemini-3.6-flash', messages: media('image/bmp') },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.countTokensCalls).toHaveLength(0)
  })
})

describe('thinking budget at or above maxOutputTokens (R3.2)', () => {
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
    expect(
      await warningsFor('gemini-3.6-flash', {
        maxOutputTokens: 100,
        reasoning: { effort: 'high' },
      }),
    ).toHaveLength(0)
  })
})
