import { describe, expect, it } from 'vitest'
import type { LlmResult } from '@gullabs/core'
import { fakeLlmResult } from './fake-llm-result.js'

/** Every field a real `LlmResult` always carries. */
const REQUIRED: Array<keyof LlmResult> = [
  'message',
  'continuation',
  'usage',
  'model',
  'latencyMs',
  'warnings',
  'callId',
  'attemptId',
  'callCost',
]

describe('fakeLlmResult', () => {
  it('has every required field, including message, continuation and callCost', () => {
    const result = fakeLlmResult()
    for (const key of REQUIRED) {
      expect(result[key], key).toBeDefined()
    }
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [{ kind: 'text', text: 'ok' }],
    })
    expect(result.continuation).toBe('history')
    expect(result.text).toBe('ok')
    expect(result.callCost).toEqual({ microUsd: 0, attempts: 1, unpricedAttempts: 1 })
  })

  it('text alone becomes the message, and message alone becomes the text', () => {
    expect(fakeLlmResult({ text: 'hello' }).message.parts).toEqual([
      { kind: 'text', text: 'hello' },
    ])
    const fromMessage = fakeLlmResult({
      message: {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'a' },
          { kind: 'text', text: 'b' },
        ],
      },
    })
    expect(fromMessage.text).toBe('ab')
  })

  it('a message with no text parts has no text', () => {
    const result = fakeLlmResult({
      message: {
        role: 'assistant',
        parts: [{ kind: 'tool-call', toolCallId: '1', toolName: 't', args: {} }],
      },
    })
    expect('text' in result).toBe(false)
  })

  it('overrides win, and callCost follows cost unless given', () => {
    const priced = fakeResultWithCost(1_500)
    expect(priced.callCost).toEqual({ microUsd: 1_500, attempts: 1, unpricedAttempts: 0 })

    const unpriced = fakeLlmResult({
      cost: {
        microUsd: null,
        usd: null,
        pricingVersion: 'v',
        confidence: 'estimated',
        details: { input: 0, cached: 0, output: 0, tools: 0 },
        unpricedReason: 'unknown model',
      },
    })
    expect(unpriced.callCost).toEqual({ microUsd: 0, attempts: 1, unpricedAttempts: 1 })

    const explicit = fakeLlmResult({
      callCost: { microUsd: 7, attempts: 3, unpricedAttempts: 1 },
    })
    expect(explicit.callCost).toEqual({ microUsd: 7, attempts: 3, unpricedAttempts: 1 })

    expect(
      fakeLlmResult({ model: 'gemini-2.5-pro', callId: 'c9', latencyMs: 40 }),
    ).toMatchObject({ model: 'gemini-2.5-pro', callId: 'c9', latencyMs: 40 })
  })

  it('returns fresh nested objects each call', () => {
    const a = fakeLlmResult()
    const b = fakeLlmResult()
    expect(a.usage).not.toBe(b.usage)
    expect(a.warnings).not.toBe(b.warnings)
    expect(a.message).not.toBe(b.message)
  })
})

function fakeResultWithCost(microUsd: number): LlmResult {
  return fakeLlmResult({
    cost: {
      microUsd,
      usd: microUsd / 1_000_000,
      pricingVersion: 'v',
      confidence: 'exact',
      details: { input: microUsd, cached: 0, output: 0, tools: 0 },
    },
  })
}
