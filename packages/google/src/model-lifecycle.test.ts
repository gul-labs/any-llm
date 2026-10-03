import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  SHUTDOWN_WARNING_DAYS,
  composeProviders,
  createClient,
  createModelRegistry,
} from '@gullabs/core'
import { FakeClock, makeFakeGemini, fakeGeminiResponse } from '@gullabs/testing'

import { geminiModelDescriptors, gemmaModelDescriptors } from './models.js'
import { googleProvider } from './provider.js'

type GemmaCall = {
  model: string
  hasGroundingMetadata: boolean
  webSearchQueries: string[]
  groundingChunks: number
  finishReason: string
  answerEmpty: boolean
}
const gemmaCapture = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/gemma-grounding-2026-10-03.json', import.meta.url),
    'utf8',
  ),
) as { calls: GemmaCall[] }

describe('Gemma grounding is backed by a live capture (ADR-013)', () => {
  it('declares grounding on exactly the models the capture covers', () => {
    const captured = [...new Set(gemmaCapture.calls.map((c) => c.model))].sort()
    expect(gemmaModelDescriptors.map((d) => d.model).sort()).toEqual(captured)
    for (const d of gemmaModelDescriptors) expect(d.capabilities?.grounding).toBe(true)
  })

  it('shows metadata on 5 of 6 calls; the miss is a truncation, not an absent feature', () => {
    expect(gemmaCapture.calls).toHaveLength(6)
    const misses = gemmaCapture.calls.filter((c) => !c.hasGroundingMetadata)
    expect(misses).toHaveLength(1)
    expect(misses[0]).toMatchObject({ finishReason: 'MAX_TOKENS', answerEmpty: true })
    for (const c of gemmaCapture.calls.filter((x) => x.hasGroundingMetadata)) {
      expect(c.webSearchQueries.length).toBeGreaterThan(0)
      expect(c.groundingChunks).toBeGreaterThan(0)
    }
  })
})

describe('shutdownDate', () => {
  it("is set on gemini-3.1-flash-lite only, to the date on Google's deprecations page", () => {
    const dated = geminiModelDescriptors.filter((d) => d.shutdownDate !== undefined)
    expect(dated.map((d) => [d.model, d.shutdownDate])).toEqual([
      ['gemini-3.1-flash-lite', '2027-05-07'],
    ])
  })

  const DAY = 86_400_000
  const shutdown = Date.UTC(2027, 4, 7)

  async function warningsAt(nowMs: number, model: string): Promise<string[]> {
    const clock = new FakeClock(nowMs)
    const client = createClient({
      ...composeProviders([
        googleProvider({
          client: makeFakeGemini(
            fakeGeminiResponse({
              text: 'ok',
              promptTokenCount: 1,
              candidatesTokenCount: 1,
            }),
          ),
        }),
      ]),
      clock,
      scheduler: clock,
    })
    const result = await client.generate(
      {
        provider: 'google',
        model,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'test' } },
    )
    return result.warnings.map((w) => w.message)
  }

  it('is silent more than 90 days before the date', async () => {
    expect(SHUTDOWN_WARNING_DAYS).toBe(90)
    expect(await warningsAt(shutdown - 91 * DAY, 'gemini-3.1-flash-lite')).toEqual([])
  })

  it('warns from 90 days before, naming the date and the days left', async () => {
    const warnings = await warningsAt(shutdown - 90 * DAY, 'gemini-3.1-flash-lite')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('gemini-3.1-flash-lite')
    expect(warnings[0]).toContain('2027-05-07')
    expect(warnings[0]).toContain('in 90 days')
  })

  it('still warns, and still serves the call, on and after the date', async () => {
    expect((await warningsAt(shutdown, 'gemini-3.1-flash-lite'))[0]).toContain('today')
    expect((await warningsAt(shutdown + 3 * DAY, 'gemini-3.1-flash-lite'))[0]).toContain(
      '3 days ago',
    )
  })

  it('does not warn for a model with no shutdown date, however late', async () => {
    expect(await warningsAt(shutdown + 400 * DAY, 'gemini-3.6-flash')).toEqual([])
  })

  it('rejects a descriptor whose shutdownDate is not a real YYYY-MM-DD date', () => {
    const base = geminiModelDescriptors[0]!
    for (const bad of ['2027-5-7', '2027-02-30', 'May 7, 2027', '20270507', '']) {
      expect(() => createModelRegistry([{ ...base, shutdownDate: bad }]), bad).toThrow(
        /invalid shutdownDate/,
      )
    }
    expect(() =>
      createModelRegistry([{ ...base, shutdownDate: '2027-05-07' }]),
    ).not.toThrow()
  })
})
