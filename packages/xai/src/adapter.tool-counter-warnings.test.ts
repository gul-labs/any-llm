/**
 * What the adapter says about server-tool counters the pricing snapshot cannot
 * price. Counter names for image and video understanding were never captured
 * (the pricing page, re-read 2026-10-03, lists both as token-priced with no
 * invocation fee and names no counter), so a test here uses an INVENTED counter
 * name for the unknown case and asserts only the wording and the estimated
 * confidence, never a real xAI shape.
 */
import { describe, expect, it } from 'vitest'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { fakeXaiResponse, makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok45ModelDescriptor } from './models.js'
import { computeXaiCost } from './pricing.js'
import type { XaiProviderOptions } from './types.js'

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const run = (
  counters: Record<string, number>,
  tools: NonNullable<XaiProviderOptions['tools']>,
  extra: Partial<ResolvedRequest> = {},
) => {
  const response = fakeXaiResponse({ text: 'ok', inputTokens: 1000, outputTokens: 100 })
  response.usage['server_side_tool_usage_details'] = { web_search_calls: 1, ...counters }
  return xaiAdapter({ client: makeFakeXai(response) }).run(
    {
      provider: 'xai',
      model: 'grok-4.5',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      config: { providerOptions: { xai: { tools } } },
      modelDescriptor: grok45ModelDescriptor,
      ...extra,
    },
    CTX,
  )
}

const messages = (warnings: Array<{ message: string }>): string[] =>
  warnings.map((w) => w.message)

describe('unpriced server-tool counter warnings', () => {
  it('an unknown counter beside image understanding does not claim the call understates', async () => {
    const result = await run({ view_image_calls: 3 }, [
      { type: 'web_search', enableImageUnderstanding: true },
    ])
    const text = messages(result.warnings).join('\n')
    expect(text).toContain('view_image_calls=3')
    expect(text).toContain('image or video understanding')
    expect(text).not.toContain('understates')
    expect(text).not.toContain('may understate')
    // The pricing table is unchanged: the unknown counter keeps the call estimated.
    expect(computeXaiCost('grok-4.5', result.usage).confidence).toBe('estimated')
  })

  it('an unknown counter beside X video understanding says the same', async () => {
    const result = await run({ view_video_calls: 1 }, [
      { type: 'web_search' },
      { type: 'x_search', enableVideoUnderstanding: true },
    ])
    expect(messages(result.warnings).join('\n')).toContain('image or video understanding')
  })

  it('an unknown counter with no understanding enabled may understate', async () => {
    const result = await run({ view_image_calls: 3 }, [{ type: 'web_search' }])
    const text = messages(result.warnings).join('\n')
    expect(text).toContain('may understate')
    expect(text).not.toContain('image or video understanding')
  })

  it('a known per-use counter (code execution) still understates', async () => {
    const result = await run({ code_interpreter_calls: 2 }, [
      { type: 'web_search', enableImageUnderstanding: true },
    ])
    const text = messages(result.warnings).join('\n')
    expect(text).toContain('code_interpreter_calls=2')
    expect(text).toContain('and understates')
    expect(text).not.toContain('image or video understanding')
  })

  it('a file attachment gets one warning for document_search_calls, not two', async () => {
    const result = await run({ document_search_calls: 1 }, [{ type: 'web_search' }], {
      messages: [{ role: 'user', parts: [{ kind: 'file-ref', fileId: 'file_123' }] }],
    })
    const all = messages(result.warnings)
    expect(all.filter((m) => m.includes('attachment_search'))).toHaveLength(1)
    expect(all.filter((m) => m.includes('document_search_calls'))).toHaveLength(0)
    expect(computeXaiCost('grok-4.5', result.usage).confidence).toBe('estimated')
  })
})
