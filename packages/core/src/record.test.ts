/**
 * Unit tests for record.ts — buildRecord and errorKindToStatus.
 */

import { describe, it, expect } from 'vitest'
import { buildRecord, errorKindToStatus } from './record.js'
import { LlmError } from './errors.js'
import type { BuildRecordInput } from './record.js'
import type { Usage, Cost, GenConfig } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    details: {},
    raw: { promptTokenCount: 100, candidatesTokenCount: 50 },
    ...overrides,
  }
}

function makeCost(overrides: Partial<Cost> = {}): Cost {
  return {
    microUsd: 1500,
    usd: 1500 / 1_000_000,
    pricingVersion: 'gemini-2026-06-27',
    confidence: 'exact',
    details: { input: 1000, cached: 0, output: 500, tools: 0 },
    ...overrides,
  }
}

function makeConfig(overrides: Partial<GenConfig> = {}): GenConfig {
  return {
    temperature: 0.7,
    serviceTier: 'flex',
    ...overrides,
  }
}

function makeBaseInput(overrides: Partial<BuildRecordInput> = {}): BuildRecordInput {
  return {
    callId: 'call-001',
    attemptId: 'attempt-001',
    attemptNumber: 1,
    provider: 'google',
    model: 'gemini-2.5-pro',
    usage: makeUsage(),
    latencyMs: 1234,
    status: 'ok',
    generationConfig: makeConfig(),
    metadata: { tenantId: 'tenant-abc' },
    createdAt: '2026-06-27T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildRecord — success path
// ---------------------------------------------------------------------------

describe('buildRecord — success path', () => {
  it('sets recordSchemaVersion to 1', () => {
    const r = buildRecord(makeBaseInput())
    expect(r.recordSchemaVersion).toBe(1)
  })

  it('persists requested toolNames and toolCount even without toolCalls', () => {
    const r = buildRecord(makeBaseInput({ toolNames: ['get_temperature', 'lookup'] }))
    expect(r.toolNames).toEqual(['get_temperature', 'lookup'])
    expect(r.toolCount).toBe(2)
    expect(r.toolCalls).toBeUndefined()
  })

  it('persists toolCalls when present and omits empty arrays', () => {
    const toolCalls = [
      { toolCallId: 'c1', toolName: 'get_temperature', args: { location: 'SF' } },
    ]
    const withCalls = buildRecord(makeBaseInput({ toolCalls }))
    expect(withCalls.toolCalls).toEqual(toolCalls)

    const empty = buildRecord(makeBaseInput({ toolCalls: [] }))
    expect(empty.toolCalls).toBeUndefined()
  })

  it('persists citations when present and omits empty arrays', () => {
    const citations = [{ url: 'https://example.com', title: 'Example' }]
    const withCitations = buildRecord(makeBaseInput({ citations }))
    expect(withCitations.citations).toEqual(citations)

    const empty = buildRecord(makeBaseInput({ citations: [] }))
    expect(empty.citations).toBeUndefined()
  })

  it('maps identity fields', () => {
    const r = buildRecord(
      makeBaseInput({ callId: 'c-1', attemptId: 'a-1', callSiteId: 'site-x' }),
    )
    expect(r.callId).toBe('c-1')
    expect(r.attemptId).toBe('a-1')
    expect(r.callSiteId).toBe('site-x')
  })

  it('callSiteId absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('callSiteId' in r).toBe(false)
  })

  it('maps authKeyId when provided (ADR-026)', () => {
    const r = buildRecord(makeBaseInput({ authKeyId: 'gemini-paid' }))
    expect(r.authKeyId).toBe('gemini-paid')
  })

  it('authKeyId absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('authKeyId' in r).toBe(false)
  })

  it('authKeyId is never redacted, even when it looks like a secret pattern', () => {
    // A value that redactSecrets would normally scrub if it ran over this
    // field (e.g. an AIza-prefixed Google API key shape). authKeyId is a
    // label, not a secret, and must pass through byte-for-byte.
    const suspiciousLabel = 'AIzaSyD-abcdefghijklmnopqrstuvwxyz1234567'
    const r = buildRecord(makeBaseInput({ authKeyId: suspiciousLabel }))
    expect(r.authKeyId).toBe(suspiciousLabel)
  })

  it('maps routing fields', () => {
    const r = buildRecord(
      makeBaseInput({
        provider: 'google',
        model: 'gemini-2.5-pro',
        modelVersion: 'gemini-2.5-pro-001',
        responseId: 'resp-xyz',
        serviceTier: 'flex',
      }),
    )
    expect(r.provider).toBe('google')
    expect(r.model).toBe('gemini-2.5-pro')
    expect(r.modelVersion).toBe('gemini-2.5-pro-001')
    expect(r.responseId).toBe('resp-xyz')
    expect(r.serviceTier).toBe('flex')
  })

  it('optional routing fields absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('modelVersion' in r).toBe(false)
    expect('responseId' in r).toBe(false)
    expect('serviceTier' in r).toBe(false)
  })

  it('maps status and finishReason', () => {
    const r = buildRecord(makeBaseInput({ status: 'ok', finishReason: 'stop' }))
    expect(r.status).toBe('ok')
    expect(r.finishReason).toBe('stop')
  })

  it('finishReason absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('finishReason' in r).toBe(false)
  })

  it('maps latencyMs', () => {
    const r = buildRecord(makeBaseInput({ latencyMs: 9876 }))
    expect(r.latencyMs).toBe(9876)
  })

  it('maps queueDelayMs when provided', () => {
    const r = buildRecord(makeBaseInput({ queueDelayMs: 250 }))
    expect(r.queueDelayMs).toBe(250)
  })

  it('maps usage hot fields', () => {
    const r = buildRecord(
      makeBaseInput({
        usage: makeUsage({
          inputTokens: 250_000,
          outputTokens: 5_000,
          cachedInputTokens: 100_000,
          thinkingTokens: 2_000,
          totalTokens: 255_000,
        }),
      }),
    )
    expect(r.inputTokens).toBe(250_000)
    expect(r.outputTokens).toBe(5_000)
    expect(r.cachedInputTokens).toBe(100_000)
    expect(r.thinkingTokens).toBe(2_000)
    expect(r.totalTokens).toBe(255_000)
  })

  it('optional usage fields absent when not in Usage', () => {
    const r = buildRecord(makeBaseInput({ usage: makeUsage() }))
    expect('cachedInputTokens' in r).toBe(false)
    expect('thinkingTokens' in r).toBe(false)
    expect('totalTokens' in r).toBe(false)
  })

  it('maps cost fields', () => {
    const cost = makeCost({ microUsd: 2000, pricingVersion: 'gemini-2026-06-27' })
    const r = buildRecord(makeBaseInput({ cost }))
    expect(r.costMicroUsd).toBe(2000)
    expect(r.pricingVersion).toBe('gemini-2026-06-27')
  })

  it('cost fields absent when cost not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('costMicroUsd' in r).toBe(false)
    expect('pricingVersion' in r).toBe(false)
  })

  it('maps null microUsd when model is unpriced', () => {
    const cost = makeCost({ microUsd: null })
    const r = buildRecord(makeBaseInput({ cost }))
    expect(r.costMicroUsd).toBeNull()
  })

  it('maps tokenDetails from usage.details', () => {
    const r = buildRecord(
      makeBaseInput({
        usage: makeUsage({ details: { customTokenType: 42 } }),
      }),
    )
    expect(r.tokenDetails).toEqual({ customTokenType: 42 })
  })

  it('maps rawUsage from usage.raw', () => {
    const raw = {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
    }
    const r = buildRecord(makeBaseInput({ usage: makeUsage({ raw }) }))
    expect(r.rawUsage).toEqual(raw)
  })

  it('maps providerMetadata when provided', () => {
    const meta = {
      safetyRatings: [
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'NEGLIGIBLE' },
      ],
    }
    const r = buildRecord(makeBaseInput({ providerMetadata: meta }))
    expect(r.providerMetadata).toEqual(meta)
  })

  it('providerMetadata absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('providerMetadata' in r).toBe(false)
  })

  it('maps warnings as JSONB', () => {
    const warnings = [{ type: 'other' as const, message: 'topK not supported' }]
    const r = buildRecord(makeBaseInput({ warnings }))
    expect(r.warnings).toEqual(warnings)
  })

  it('warnings absent when array is empty', () => {
    const r = buildRecord(makeBaseInput({ warnings: [] }))
    expect('warnings' in r).toBe(false)
  })

  it('warnings absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('warnings' in r).toBe(false)
  })

  it('maps generationConfig as JSONB', () => {
    const config: GenConfig = { temperature: 0.5, serviceTier: 'flex' }
    const r = buildRecord(makeBaseInput({ generationConfig: config }))
    expect(r.generationConfig).toEqual(config)
  })

  it('maps metadata', () => {
    const metadata = { tenantId: 'tenant-123', runId: 'run-456' }
    const r = buildRecord(makeBaseInput({ metadata }))
    expect(r.metadata).toEqual(metadata)
  })

  it('maps createdAt', () => {
    const r = buildRecord(makeBaseInput({ createdAt: '2026-06-27T00:00:00.000Z' }))
    expect(r.createdAt).toBe('2026-06-27T00:00:00.000Z')
  })

  it('no errorKind/errorMessage on success', () => {
    const r = buildRecord(makeBaseInput({ status: 'ok' }))
    expect('errorKind' in r).toBe(false)
    expect('errorMessage' in r).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildRecord — reasoning capture
// ---------------------------------------------------------------------------

describe('buildRecord — reasoning capture', () => {
  it('maps reasoningText when provided', () => {
    const r = buildRecord(
      makeBaseInput({ reasoningText: 'Let me think step by step...' }),
    )
    expect(r.reasoningText).toBe('Let me think step by step...')
  })

  it('reasoningText absent when not provided', () => {
    const r = buildRecord(makeBaseInput())
    expect('reasoningText' in r).toBe(false)
  })

  it('responseId preserved', () => {
    const r = buildRecord(makeBaseInput({ responseId: 'resp-abc-123' }))
    expect(r.responseId).toBe('resp-abc-123')
  })
})

// ---------------------------------------------------------------------------
// buildRecord — error path
// ---------------------------------------------------------------------------

describe('buildRecord — error path', () => {
  it('sets errorKind and errorMessage on failure', () => {
    const error = new LlmError('Service temporarily unavailable', {
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
    const r = buildRecord(makeBaseInput({ status: 'api_error', error }))
    expect(r.errorKind).toBe('server')
    expect(r.errorMessage).toBe('Service temporarily unavailable')
  })

  it('persists errorReason only when the error carries one', () => {
    const withReason = new LlmError('window exhausted', {
      kind: 'rate_limited',
      retryable: false,
      reason: 'quota_window',
    })
    const r = buildRecord(makeBaseInput({ status: 'api_error', error: withReason }))
    expect(r.errorKind).toBe('rate_limited')
    expect(r.errorReason).toBe('quota_window')

    const plain = new LlmError('boom', { kind: 'server', retryable: true })
    const p = buildRecord(makeBaseInput({ status: 'api_error', error: plain }))
    expect('errorReason' in p).toBe(false)
  })

  it('derives status from error.kind — timeout', () => {
    const error = new LlmError('timed out', { kind: 'timeout', retryable: true })
    const r = buildRecord(makeBaseInput({ status: 'ok', error }))
    expect(r.status).toBe('timeout')
  })

  it('derives status from error.kind — aborted', () => {
    const error = new LlmError('aborted', { kind: 'aborted', retryable: false })
    const r = buildRecord(makeBaseInput({ status: 'ok', error }))
    expect(r.status).toBe('aborted')
  })

  it('derives status from error.kind — content_filter', () => {
    const error = new LlmError('content filtered', {
      kind: 'content_filter',
      retryable: false,
    })
    const r = buildRecord(makeBaseInput({ status: 'ok', error }))
    expect(r.status).toBe('content_filter')
  })

  it('collapses invalid_auth → api_error', () => {
    const error = new LlmError('invalid key', { kind: 'invalid_auth', retryable: false })
    const r = buildRecord(makeBaseInput({ error }))
    expect(r.status).toBe('api_error')
  })

  it('collapses rate_limited → api_error', () => {
    const error = new LlmError('rate limit', { kind: 'rate_limited', retryable: true })
    const r = buildRecord(makeBaseInput({ error }))
    expect(r.status).toBe('api_error')
  })

  it('collapses bad_request → api_error', () => {
    const error = new LlmError('bad req', { kind: 'bad_request', retryable: false })
    const r = buildRecord(makeBaseInput({ error }))
    expect(r.status).toBe('api_error')
  })

  it('collapses unknown → api_error', () => {
    const error = new LlmError('unknown', { kind: 'unknown', retryable: false })
    const r = buildRecord(makeBaseInput({ error }))
    expect(r.status).toBe('api_error')
  })
})

// ---------------------------------------------------------------------------
// errorKindToStatus
// ---------------------------------------------------------------------------

describe('errorKindToStatus', () => {
  it('timeout → timeout', () => {
    expect(errorKindToStatus('timeout')).toBe('timeout')
  })
  it('aborted → aborted', () => {
    expect(errorKindToStatus('aborted')).toBe('aborted')
  })
  it('content_filter → content_filter', () => {
    expect(errorKindToStatus('content_filter')).toBe('content_filter')
  })
  it('invalid_auth → api_error', () => {
    expect(errorKindToStatus('invalid_auth')).toBe('api_error')
  })
  it('rate_limited → api_error', () => {
    expect(errorKindToStatus('rate_limited')).toBe('api_error')
  })
  it('server → api_error', () => {
    expect(errorKindToStatus('server')).toBe('api_error')
  })
  it('bad_request → api_error', () => {
    expect(errorKindToStatus('bad_request')).toBe('api_error')
  })
  it('unknown → api_error', () => {
    expect(errorKindToStatus('unknown')).toBe('api_error')
  })
})

// ---------------------------------------------------------------------------
// Usage gross/subset values — SPEC invariant stress
// ---------------------------------------------------------------------------

describe('buildRecord — gross/subset usage invariant', () => {
  it('preserves GROSS token counts exactly (250k/100k/5k/2k scenario)', () => {
    // This is the canonical high-risk test from SPEC §Testing.
    // input=250k (gross), cached=100k (subset), output=5k (gross), thinking=2k (subset)
    const usage = makeUsage({
      inputTokens: 250_000,
      outputTokens: 5_000,
      cachedInputTokens: 100_000,
      thinkingTokens: 2_000,
      totalTokens: 255_000,
    })
    const cost = makeCost({
      microUsd: 1_750_000, // example: 150k*input + 100k*cached + 5k*output
      details: { input: 1_500_000, cached: 200_000, output: 50_000, tools: 0 },
    })
    const r = buildRecord(makeBaseInput({ usage, cost }))

    // GROSS values preserved verbatim.
    expect(r.inputTokens).toBe(250_000)
    expect(r.outputTokens).toBe(5_000)
    // Subset values preserved verbatim (no subtraction).
    expect(r.cachedInputTokens).toBe(100_000)
    expect(r.thinkingTokens).toBe(2_000)
    expect(r.totalTokens).toBe(255_000)
    // Cost frozen correctly.
    expect(r.costMicroUsd).toBe(1_750_000)
  })
})

// ---------------------------------------------------------------------------
// Usage invariant clamping — Finding 2
// ---------------------------------------------------------------------------

describe('buildRecord — usage invariant clamping (fail-open)', () => {
  it('clamps cachedInputTokens > inputTokens and emits an other warning', () => {
    const usage = makeUsage({
      inputTokens: 100,
      cachedInputTokens: 200, // violates: cached > input
    })
    const r = buildRecord(makeBaseInput({ usage }))

    // Clamped to parent (inputTokens).
    expect(r.cachedInputTokens).toBe(100)

    // A warning must be present describing the clamp.
    const warnings = r.warnings as Array<{ type: string; message: string }>
    expect(warnings).toBeDefined()
    expect(Array.isArray(warnings)).toBe(true)
    expect(
      warnings.some((w) => w.type === 'other' && /cachedInputTokens/.test(w.message)),
    ).toBe(true)
  })

  it('clamps thinkingTokens > outputTokens and emits an other warning', () => {
    const usage = makeUsage({
      outputTokens: 50,
      thinkingTokens: 100, // violates: thinking > output
    })
    const r = buildRecord(makeBaseInput({ usage }))

    // Clamped to parent (outputTokens).
    expect(r.thinkingTokens).toBe(50)

    const warnings = r.warnings as Array<{ type: string; message: string }>
    expect(warnings).toBeDefined()
    expect(
      warnings.some((w) => w.type === 'other' && /thinkingTokens/.test(w.message)),
    ).toBe(true)
  })

  it('does not modify valid usage — cached<=input and thinking<=output', () => {
    const usage = makeUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 80,
      thinkingTokens: 30,
    })
    const r = buildRecord(makeBaseInput({ usage }))

    expect(r.cachedInputTokens).toBe(80)
    expect(r.thinkingTokens).toBe(30)
    // No clamp warnings produced for valid usage; warnings field absent (no other warnings either).
    expect('warnings' in r).toBe(false)
  })

  it('merges clamp warnings with any pre-existing caller warnings', () => {
    const usage = makeUsage({
      inputTokens: 100,
      cachedInputTokens: 150, // violates
    })
    const callerWarning = { type: 'other' as const, message: 'topK not supported' }
    const r = buildRecord(makeBaseInput({ usage, warnings: [callerWarning] }))

    const warnings = r.warnings as Array<{ type: string }>
    expect(warnings).toBeDefined()
    // Both the caller warning and the clamp warning are present.
    expect(warnings.filter((w) => w.type === 'other')).toHaveLength(2)
  })

  it('clamps both cachedInputTokens and thinkingTokens when both violate', () => {
    const usage = makeUsage({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 50, // > inputTokens
      thinkingTokens: 40, // > outputTokens
    })
    const r = buildRecord(makeBaseInput({ usage }))

    expect(r.cachedInputTokens).toBe(10)
    expect(r.thinkingTokens).toBe(20)

    const warnings = r.warnings as Array<{ type: string; message: string }>
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })
})
