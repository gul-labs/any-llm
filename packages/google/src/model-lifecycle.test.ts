import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  SHUTDOWN_WARNING_DAYS,
  composeProviders,
  createClient,
  createModelRegistry,
} from '@gullabs/core'
import type { Warning } from '@gullabs/core'
import {
  FakeClock,
  RecordingSink,
  makeFakeGemini,
  fakeGeminiResponse,
} from '@gullabs/testing'

import { geminiModelDescriptors, gemmaModelDescriptors } from './models.js'
import { googleProvider } from './provider.js'

type GemmaCall = {
  model: string
  hasGroundingMetadata: boolean
  webSearchQueries: string[]
  groundingChunks: number
  finishReason: string
  answerEmpty: boolean
  usage: {
    promptTokenCount: number
    candidatesTokenCount: number
    thoughtsTokenCount: number
    totalTokenCount: number
  }
}
const gemmaCapture = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/gemma-grounding-2026-10-03.json', import.meta.url),
    'utf8',
  ),
) as {
  kind: string
  description: string
  counts: {
    calls: number
    completed: number
    completedWithGroundingMetadata: number
    truncatedByMaxTokens: number
    truncatedWithGroundingMetadata: number
  }
  calls: GemmaCall[]
}

// The fixture is a derived summary (flags and counts extracted from six live responses; the
// answer text and raw metadata were not kept), so this test can check it against itself and
// the descriptors, not against the provider. It cannot detect a wrong capture.
describe('Gemma grounding is backed by a live capture (ADR-013)', () => {
  it('says what it is: a derived summary, not the raw responses', () => {
    expect(gemmaCapture.kind).toBe('derived-summary')
    expect(gemmaCapture.description).toContain('DERIVED SUMMARY')
    expect(gemmaCapture.description).toContain('not the raw responses')
  })

  it('declares grounding on exactly the models the capture covers', () => {
    const captured = [...new Set(gemmaCapture.calls.map((c) => c.model))].sort()
    expect(gemmaModelDescriptors.map((d) => d.model).sort()).toEqual(captured)
    for (const d of gemmaModelDescriptors) expect(d.capabilities?.grounding).toBe(true)
  })

  it('states counts that the entries add up to', () => {
    const completed = gemmaCapture.calls.filter((c) => c.finishReason === 'STOP')
    const truncated = gemmaCapture.calls.filter((c) => c.finishReason === 'MAX_TOKENS')
    expect(gemmaCapture.counts).toEqual({
      calls: gemmaCapture.calls.length,
      completed: completed.length,
      completedWithGroundingMetadata: completed.filter((c) => c.hasGroundingMetadata)
        .length,
      truncatedByMaxTokens: truncated.length,
      truncatedWithGroundingMetadata: truncated.filter((c) => c.hasGroundingMetadata)
        .length,
      note: expect.stringContaining('5 of 5 completed calls'),
    })
    expect(gemmaCapture.counts.calls).toBe(completed.length + truncated.length)
  })

  it('shows metadata on 5 of 5 completed calls; the sixth is a truncation that proves nothing', () => {
    const { counts, calls } = gemmaCapture
    expect([counts.completed, counts.completedWithGroundingMetadata]).toEqual([5, 5])
    expect(calls).toHaveLength(6)
    const misses = calls.filter((c) => !c.hasGroundingMetadata)
    expect(misses).toHaveLength(1)
    expect(misses[0]).toMatchObject({ finishReason: 'MAX_TOKENS', answerEmpty: true })
    for (const c of calls.filter((x) => x.hasGroundingMetadata)) {
      expect(c.finishReason).toBe('STOP')
      expect(c.webSearchQueries.length).toBeGreaterThan(0)
      expect(c.groundingChunks).toBeGreaterThan(0)
    }
  })

  it('has usage that reconciles on every call (prompt + answer + thoughts = total)', () => {
    for (const c of gemmaCapture.calls) {
      const u = c.usage
      expect(u.promptTokenCount + u.candidatesTokenCount + u.thoughtsTokenCount).toBe(
        u.totalTokenCount,
      )
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

  function clientAt(nowMs: number) {
    const clock = new FakeClock(nowMs)
    const sink = new RecordingSink()
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
      sink,
    })
    const call = (model: string) =>
      client.generate(
        {
          provider: 'google',
          model,
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: { apiKey: 'test' } },
      )
    return { call, sink }
  }

  async function warningsAt(nowMs: number, model: string): Promise<Warning[]> {
    return (await clientAt(nowMs).call(model)).warnings
  }
  const messagesAt = async (nowMs: number, model: string) =>
    (await warningsAt(nowMs, model)).map((w) => w.message)

  it('is silent more than 90 days before the date', async () => {
    expect(SHUTDOWN_WARNING_DAYS).toBe(90)
    expect(await warningsAt(shutdown - 91 * DAY, 'gemini-3.1-flash-lite')).toEqual([])
  })

  it('warns from 90 days before, naming the date and the days left', async () => {
    const warnings = await messagesAt(shutdown - 90 * DAY, 'gemini-3.1-flash-lite')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('gemini-3.1-flash-lite')
    expect(warnings[0]).toContain('2027-05-07')
    expect(warnings[0]).toContain('in 90 days')
    expect(warnings[0]).toContain('is scheduled to shut down')
  })

  it('is a typed warning a host can match without a regex', async () => {
    const [warning] = await warningsAt(shutdown - 10 * DAY, 'gemini-3.1-flash-lite')
    expect(warning).toMatchObject({ type: 'shutdown', shutdownDate: '2027-05-07' })
  })

  it('still warns, and still serves the call, on and after the date, in the past tense', async () => {
    const today = (await messagesAt(shutdown, 'gemini-3.1-flash-lite'))[0]
    expect(today).toContain('is scheduled to shut down today')
    const after = (await messagesAt(shutdown + 3 * DAY, 'gemini-3.1-flash-lite'))[0]
    expect(after).toContain('was scheduled to shut down on 2027-05-07 (3 days ago)')
    expect(after).toContain('may stop being served at any time')
    expect(after).not.toContain('before then')
  })

  it('warns once per client and model, not on every call', async () => {
    const { call, sink } = clientAt(shutdown - 10 * DAY)
    expect((await call('gemini-3.1-flash-lite')).warnings).toHaveLength(1)
    expect((await call('gemini-3.1-flash-lite')).warnings).toEqual([])
    expect((await call('gemini-3.1-flash-lite')).warnings).toEqual([])
    // The ledger rows carry it once too: the first row only.
    const rows = sink.records.map(
      (r) => ((r.warnings as unknown[] | undefined) ?? []).length,
    )
    expect(rows).toEqual([1, 0, 0])
    // Another client has not warned yet, so it warns once for itself.
    expect(
      (await clientAt(shutdown - 10 * DAY).call('gemini-3.1-flash-lite')).warnings,
    ).toHaveLength(1)
  })

  it('a model with no shutdown date never uses up or triggers the advisory', async () => {
    const { call } = clientAt(shutdown + 3 * DAY)
    expect((await call('gemini-3.6-flash')).warnings).toEqual([])
    expect((await call('gemini-3.1-flash-lite')).warnings).toHaveLength(1)
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
