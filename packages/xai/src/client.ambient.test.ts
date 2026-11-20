/**
 * The ambient `OPENAI_*` environment cannot move or re-credential an xAI call
 * (ADR-019): the real `openai` SDK client over a stubbed `fetch` (synthetic
 * event stream, `test-sse.ts`).
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildXaiClient } from './client.js'
import { sseResponse, synthesizeStreamEvents } from './test-sse.js'

const OK_RESPONSE = {
  id: 'resp_1',
  model: 'grok-4.5',
  status: 'completed',
  output: [],
  usage: { input_tokens: 1, output_tokens: 1 },
}

describe('buildXaiClient — ambient OPENAI_* variables', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('none of them changes the destination or the headers sent to xAI', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-ambient-must-not-be-sent')
    vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.invalid/v1')
    vi.stubEnv('OPENAI_ORG_ID', 'org-ambient')
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-ambient')
    vi.stubEnv('OPENAI_ADMIN_KEY', 'sk-admin-ambient')
    vi.stubEnv('OPENAI_WEBHOOK_SECRET', 'whsec-ambient')
    vi.stubEnv('OPENAI_LOG', 'debug')
    vi.stubEnv(
      'OPENAI_CUSTOM_HEADERS',
      'Authorization: Bearer sk-ambient-header\nX-Ambient: 1\nOpenAI-Organization: org-header',
    )
    const writes = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    )
    const seen: Array<{ url: string; headers: Headers }> = []
    const client = await buildXaiClient(
      { apiKey: 'xai-caller' },
      {
        fetch: (async (input: unknown, init?: RequestInit) => {
          seen.push({ url: String(input), headers: new Headers(init?.headers) })
          return sseResponse(synthesizeStreamEvents(OK_RESPONSE))
        }) as typeof fetch,
      },
    )
    await client.responses.create({ model: 'grok-4.5', input: [], store: false })

    expect(seen).toHaveLength(1)
    const call = seen[0]!
    expect(call.url).toBe('https://api.x.ai/v1/responses')
    expect(call.headers.get('authorization')).toBe('Bearer xai-caller')
    expect(call.headers.has('x-ambient')).toBe(false)
    expect(call.headers.has('openai-organization')).toBe(false)
    expect(call.headers.has('openai-project')).toBe(false)
    expect([...call.headers.values()].join('\n')).not.toContain('ambient')
    for (const spy of writes) expect(spy).not.toHaveBeenCalled()
  })

  it('a malformed OPENAI_CUSTOM_HEADERS still fails construction (known gap, BACKLOG)', async () => {
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Bad Header: value')
    // The SDK client is constructed in buildXaiClient, so that is what fails.
    await expect(
      buildXaiClient(
        { apiKey: 'xai-caller' },
        {
          fetch: (async () =>
            sseResponse(synthesizeStreamEvents(OK_RESPONSE))) as typeof fetch,
        },
      ),
    ).rejects.toThrow(/valid HTTP token/)
  })
})
