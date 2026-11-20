/**
 * `incomplete_details.reason` → `finishReason`.
 *
 * DOCUMENTATION-DERIVED, not captures (ADR-013): the four reason values are the
 * `IncompleteDetails.reason` enum of xAI's published OpenAPI document
 * (https://docs.x.ai/openapi.json, read 2026-11-20). Only `max_output_tokens`
 * has a live capture (fixture 08). The response objects below are built here
 * from that enum, not recorded from xAI; the reason `unknown_reason` is a
 * made-up value that stands for a future addition to the enum.
 */
import { describe, expect, it } from 'vitest'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { fakeXaiResponse, makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok47ModelDescriptor } from './models.js'
import { sseResponse, synthesizeStreamEvents } from './test-sse.js'

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function req(): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.7',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: grok47ModelDescriptor,
  }
}

const incomplete = (reason: string) =>
  fakeXaiResponse({
    text: 'partial',
    status: 'incomplete',
    incompleteReason: reason,
    model: 'grok-4.7',
    inputTokens: 100,
    outputTokens: 40,
  })

describe('incomplete_details.reason (OpenAPI IncompleteDetails.reason, read 2026-11-20)', () => {
  it('max_output_tokens is length, with no warning', async () => {
    const result = await xaiAdapter({
      client: makeFakeXai(incomplete('max_output_tokens')),
    }).run(req(), CTX)
    expect(result.finishReason).toBe('length')
    expect(result.warnings).toEqual([])
  })

  it('content_filter is content_filter, with no warning, and keeps the partial text', async () => {
    const result = await xaiAdapter({
      client: makeFakeXai(incomplete('content_filter')),
    }).run(req(), CTX)
    expect(result.finishReason).toBe('content_filter')
    expect(result.text).toBe('partial')
    expect(result.warnings).toEqual([])
  })

  it.each(['max_prompt_tokens', 'max_time_limit', 'unknown_reason'])(
    '%s is other, with one warning that names the reason',
    async (reason) => {
      const result = await xaiAdapter({ client: makeFakeXai(incomplete(reason)) }).run(
        req(),
        CTX,
      )
      expect(result.finishReason).toBe('other')
      expect(result.text).toBe('partial')
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]?.type).toBe('other')
      expect(result.warnings[0]?.message).toContain(`"${reason}"`)
      expect(result.warnings[0]?.message).toContain('"other"')
    },
  )

  it('an incomplete response with no reason is other, with no warning (nothing to name)', async () => {
    const result = await xaiAdapter({
      client: makeFakeXai(fakeXaiResponse({ text: 'partial', status: 'incomplete' })),
    }).run(req(), CTX)
    expect(result.finishReason).toBe('other')
    expect(result.warnings).toEqual([])
  })

  it('a reason beside a completed status is ignored: stop, no warning', async () => {
    const result = await xaiAdapter({
      client: makeFakeXai(
        fakeXaiResponse({
          text: 'ok',
          status: 'completed',
          incompleteReason: 'max_time_limit',
        }),
      ),
    }).run(req(), CTX)
    expect(result.finishReason).toBe('stop')
    expect(result.warnings).toEqual([])
  })

  it.each([
    ['content_filter', 'content_filter', 0],
    ['max_prompt_tokens', 'other', 1],
    ['max_time_limit', 'other', 1],
  ] as const)(
    'through the real SDK stream: response.incomplete with %s is %s (%i warning)',
    async (reason, finishReason, warningCount) => {
      const final = {
        id: 'resp_1',
        model: 'grok-4.7',
        status: 'incomplete',
        incomplete_details: { reason },
        usage: { input_tokens: 100, output_tokens: 40 },
        output: [],
      }
      const events = synthesizeStreamEvents(final, {
        terminal: 'response.incomplete',
        omitDone: true,
      })
      const adapter = xaiAdapter({
        transport: {
          fetch: (() => Promise.resolve(sseResponse(events))) as typeof fetch,
        },
      })
      const result = await adapter.run(req(), CTX)
      expect(result.finishReason).toBe(finishReason)
      expect(result.warnings).toHaveLength(warningCount)
      if (warningCount > 0) {
        expect(result.warnings[0]?.message).toContain(`"${reason}"`)
      }
    },
  )
})
