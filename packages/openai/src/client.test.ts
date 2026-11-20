/**
 * `requireApiKey` and `buildOpenAiClient` against the real `openai` SDK with a
 * stubbed `fetch`: credentials and SDK construction (ADR-019, ADR-047).
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@gullabs/core'

import { buildOpenAiClient, requireApiKey } from './client.js'
import {
  messageItem,
  responseObject,
  sseResponse,
  streamEvents,
  stubFetch,
} from './test-sse.js'

describe('requireApiKey', () => {
  it('returns the key', () => {
    expect(requireApiKey({ apiKey: 'sk-doc' })).toBe('sk-doc')
  })

  it.each([
    ['a CLI session', { cliSession: true }],
    ['a missing key', {}],
    ['a blank key', { apiKey: '  ' }],
  ])('rejects %s as invalid_auth', (_label, auth) => {
    let thrown: unknown
    try {
      requireApiKey(auth as never)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
    expect((thrown as LlmError).provider).toBe('openai')
  })

  it('buildOpenAiClient rejects before the SDK is built', async () => {
    await expect(buildOpenAiClient({ cliSession: true })).rejects.toMatchObject({
      kind: 'invalid_auth',
    })
  })
})

describe('ambient environment cannot move or re-credential a call', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('ignores conflicting OPENAI_* variables: destination and headers are the caller’s only', async () => {
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
    const writes = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ]
    const stub = stubFetch(() =>
      sseResponse(streamEvents(responseObject([messageItem('msg_1', 'ok')]))),
    )
    const client = await buildOpenAiClient({ apiKey: 'sk-caller' }, stub.fetch)
    await client.responses.create({ model: 'gpt-6.2-sol', input: [], store: false })

    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]!
    expect(call.url).toBe('https://api.openai.com/v1/responses')
    expect(call.headers.get('authorization')).toBe('Bearer sk-caller')
    expect(call.headers.has('openai-organization')).toBe(false)
    expect(call.headers.has('openai-project')).toBe(false)
    expect(call.headers.has('x-ambient')).toBe(false)
    const sent = [...call.headers.values()].join('\n')
    expect(sent).not.toContain('ambient')
    for (const spy of writes) expect(spy).not.toHaveBeenCalled()
  })

  it('without the custom-header guard the SDK would apply OPENAI_CUSTOM_HEADERS after auth (the SDK behaviour the guard exists for)', async () => {
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'X-Ambient: 1')
    const { default: OpenAI } = await import('openai')
    const stub = stubFetch(() =>
      sseResponse(streamEvents(responseObject([messageItem('msg_1', 'ok')]))),
    )
    const raw = new OpenAI({ apiKey: 'sk-caller', maxRetries: 0, fetch: stub.fetch })
    const stream = raw.responses.stream({ model: 'gpt-6.2-sol', input: [], store: false })
    await stream.finalResponse()
    expect(stub.calls[0]!.headers.get('x-ambient')).toBe('1')
  })
})
