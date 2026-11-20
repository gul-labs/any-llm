/** Live provider contract captured on 2026-09-26 with paid development keys. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultGeminiRegistry } from './models.js'
import { classifyGoogleError } from './errors.js'

interface Probe {
  status: number
  errorStatus?: string
  message?: string
  usageServiceTier?: string
  json?: { answer?: string }
  searchPrompt?: {
    status: number
    json: { source?: string }
    groundingMetadataPresent: boolean
  }
  initialNoCandidate?: {
    status: number
    candidateCount: number
    thoughtsTokenCount: number
  }
}
interface CacheProbe {
  below: { tokens: number; status: number; message: string }
  at: { tokens: number; status: number; usageTokens: number }
}
interface LiveFixture {
  minimalReasoning: Record<string, Probe>
  structuredSearch: Record<string, Probe>
  cacheMinimum: Record<string, CacheProbe>
  flexTier: Record<string, Probe>
  twoFiveAccess: Record<string, Probe>
}
const path = fileURLToPath(
  new URL('./__fixtures__/provider-live-2026-09-26.json', import.meta.url),
)
const fixture = JSON.parse(readFileSync(path, 'utf8')) as LiveFixture

/**
 * The capture keeps its rows for models since removed from the registry
 * (`gemini-3.7-flash`, removed 2026-11-20). Each fact is checked against every
 * row of the capture, and against the descriptor only for the rows whose model
 * is still registered; which models those are is pinned in models.test.ts.
 */
const stillRegistered = (models: readonly string[]): string[] =>
  models.filter((model) => defaultGeminiRegistry.resolve('google', model) !== undefined)

describe('live Gemini model-refresh contracts', () => {
  it.each(Object.keys(fixture.minimalReasoning))(
    'the capture shows MINIMAL rejected on %s',
    (model) => {
      const probe = fixture.minimalReasoning[model]!
      expect(probe).toMatchObject({ status: 400, errorStatus: 'INVALID_ARGUMENT' })
      expect(probe.message).toContain('MINIMAL is not supported')
    },
  )

  it.each(stillRegistered(Object.keys(fixture.minimalReasoning)))(
    'the %s descriptor does not admit none',
    (model) => {
      expect(
        defaultGeminiRegistry
          .resolve('google', model)
          ?.capabilities?.admittedReasoningEfforts?.includes('none'),
      ).toBe(false)
    },
  )

  const SEARCH_ACCEPTED = [
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ]
  it.each(SEARCH_ACCEPTED)(
    'the capture shows structured JSON plus Search accepted on %s',
    (model) => {
      const probe = fixture.structuredSearch[model]!
      expect(probe.status).toBe(200)
      expect(probe.json?.answer).toEqual(expect.any(String))
      expect(probe.searchPrompt).toMatchObject({
        status: 200,
        json: { source: expect.any(String) },
      })
    },
  )

  it.each(stillRegistered(SEARCH_ACCEPTED))(
    'the %s descriptor keeps structured output with Search off anyway',
    (model) => {
      // The request was accepted, but a 200 is not evidence that Search ran
      // (docs/grounded-structured.md), so the capability stays off.
      expect(
        defaultGeminiRegistry.resolve('google', model)?.capabilities
          ?.structuredOutputWithTools,
      ).toBe(false)
    },
  )

  it.each(['gemini-3.1-pro-preview', 'gemini-3.8-flash'])(
    'returned structured JSON with Search configured on %s but the descriptor keeps it off',
    (model) => {
      expect(fixture.structuredSearch[model]).toMatchObject({
        status: 200,
        json: { answer: 'OK' },
      })
      expect(
        defaultGeminiRegistry.resolve('google', model)?.capabilities
          ?.structuredOutputWithTools,
      ).toBe(false)
    },
  )

  it('records the 3.8 Flash HTTP 200 with no candidate before its successful retry', () => {
    expect(
      fixture.structuredSearch['gemini-3.8-flash']?.initialNoCandidate,
    ).toMatchObject({
      status: 200,
      candidateCount: 0,
      thoughtsTokenCount: 113,
    })
  })

  it.each(Object.keys(fixture.cacheMinimum))(
    'the capture shows a 1,024-token explicit-cache minimum on %s',
    (model) => {
      const probe = fixture.cacheMinimum[model]!
      expect(probe.below).toMatchObject({ tokens: 103, status: 400 })
      expect(probe.below.message).toContain('min_total_token_count=1024')
      expect(probe.at).toMatchObject({ tokens: 1024, status: 200, usageTokens: 1024 })
    },
  )

  it.each(stillRegistered(Object.keys(fixture.cacheMinimum)))(
    'the %s descriptor uses the captured 1,024-token minimum',
    (model) => {
      expect(
        defaultGeminiRegistry.resolve('google', model)?.capabilities?.caching?.minTokens,
      ).toBe(1024)
    },
  )

  it.each(Object.keys(fixture.flexTier))('echoes flex on %s', (model) => {
    expect(fixture.flexTier[model]).toMatchObject({
      status: 200,
      usageServiceTier: 'flex',
    })
  })

  it('classifies the blocked 2.5 Flash-Lite key as a non-retryable request error', () => {
    const probe = fixture.twoFiveAccess['devB-gemini-2.5-flash-lite']!
    expect(probe).toMatchObject({ status: 404, errorStatus: 'NOT_FOUND' })
    const raw = new Error(
      JSON.stringify({
        error: {
          code: probe.status,
          status: probe.errorStatus,
          message: probe.message,
        },
      }),
    ) as Error & { status: number }
    raw.status = 404
    expect(classifyGoogleError(raw)).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      httpStatus: 404,
    })
    expect(fixture.twoFiveAccess['devA-gemini-2.5-flash-lite']?.status).toBe(200)
  })
})
