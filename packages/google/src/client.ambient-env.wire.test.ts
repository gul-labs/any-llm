/**
 * The SDK client is pinned, so no ambient setting moves a call (real
 * `@google/genai` 3.6.1, stubbed `fetch`, no network).
 *
 * The 3.6.1 constructor reads these variables when the matching option is not
 * passed: `GOOGLE_GENAI_USE_ENTERPRISE` / `GOOGLE_GENAI_USE_VERTEXAI` (backend),
 * `GOOGLE_GENAI_API_VERSION` (version, new in 3.0.0 together with the `v1`
 * default), `GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` (base URL),
 * `GOOGLE_API_KEY` / `GEMINI_API_KEY` (key) and `GOOGLE_CLOUD_PROJECT` /
 * `GOOGLE_CLOUD_LOCATION` (Vertex). Every one is set to a hostile value here;
 * every call the package makes (generateContent, the SDK and the REST
 * countTokens, cache create / update / delete, file upload) must still reach the
 * Developer API at `v1beta` with the caller's key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoogleGenAI } from '@google/genai'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'

import { geminiAdapter } from './adapter.js'
import { GoogleCacheStore } from './cache-store.js'
import { GoogleFileStore } from './file-store.js'
import { defaultGeminiRegistry } from './models.js'

const CALLER_KEY = 'caller-key'
const CTX: AdapterCtx = {
  auth: { apiKey: CALLER_KEY },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const MODEL = 'gemini-3.8-flash'
const UPLOAD_SESSION =
  'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1'

const AMBIENT: Readonly<Record<string, string>> = {
  GOOGLE_GENAI_API_VERSION: 'v1',
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_GENAI_USE_ENTERPRISE: 'true',
  GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.invalid',
  GOOGLE_VERTEX_BASE_URL: 'https://vertex-proxy.invalid',
  GOOGLE_API_KEY: 'ambient-google-key',
  GEMINI_API_KEY: 'ambient-gemini-key',
  GOOGLE_CLOUD_PROJECT: 'ambient-project',
  GOOGLE_CLOUD_LOCATION: 'us-central1',
}

interface Sent {
  method: string
  url: string
  apiKey: string | null
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

let sent: Sent[]

beforeEach(() => {
  sent = []
  for (const [name, value] of Object.entries(AMBIENT)) vi.stubEnv(name, value)
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit = {}) => {
    const target = String(url)
    const method = (init.method ?? 'GET').toUpperCase()
    sent.push({
      method,
      url: target,
      apiKey: new Headers(init.headers).get('x-goog-api-key'),
    })
    if (target.includes(':generateContent')) {
      return json({
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      })
    }
    if (target.includes(':countTokens')) return json({ totalTokens: 3 })
    if (target.endsWith('/cachedContents') && method === 'POST') {
      return json({
        name: 'cachedContents/c1',
        model: `models/${MODEL}`,
        expireTime: '2099-01-01T00:00:00Z',
      })
    }
    if (target.includes('/cachedContents/c1') && method === 'PATCH') {
      return json({ name: 'cachedContents/c1', expireTime: '2099-01-01T01:00:00Z' })
    }
    if (target.includes('/cachedContents/c1') && method === 'DELETE') return json({})
    if (target === UPLOAD_SESSION) {
      return json(
        {
          file: {
            name: 'files/f1',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/f1',
            mimeType: 'text/plain',
            state: 'ACTIVE',
          },
        },
        { 'x-goog-upload-status': 'final' },
      )
    }
    if (target.includes('/upload/') && method === 'POST') {
      return json({}, { 'x-goog-upload-url': UPLOAD_SESSION })
    }
    throw new Error(`unexpected request ${method} ${target}`)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function request(): ResolvedRequest {
  return {
    provider: 'google',
    model: MODEL,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: defaultGeminiRegistry.resolve('google', MODEL)!,
  }
}

describe('pinned SDK client under hostile ambient settings', () => {
  it('control: the environment above does move an unpinned 3.6.1 client', () => {
    const bare = new GoogleGenAI({ apiKey: CALLER_KEY })
    expect(bare.vertexai).toBe(true)
  })

  it('generate, both countTokens paths, cache create / update / delete and file upload all reach the Developer API at v1beta with the caller key', async () => {
    const adapter = geminiAdapter()
    await adapter.run(request(), CTX)
    // Messages only: the SDK's countTokens.
    await adapter.countTokens!(
      { provider: 'google', model: MODEL, messages: request().messages },
      CTX,
    )
    // With a system instruction: the REST countTokens with a generateContentRequest.
    await adapter.countTokens!(
      {
        provider: 'google',
        model: MODEL,
        system: 'Be brief.',
        messages: request().messages,
      },
      CTX,
    )

    const caches = new GoogleCacheStore({ auth: CTX.auth, now: () => 0 })
    const handle = await caches.create({
      model: MODEL,
      ttlSeconds: 60,
      contents: [{ role: 'user', parts: [{ text: 'cached' }] }],
    })
    const refreshed = await caches.refreshIfExpiringSoon(
      { ...handle, expiresAt: new Date(1_000) },
      { thresholdSeconds: 300, extensionSeconds: 3600 },
    )
    expect(refreshed.expiresAt.toISOString()).toBe('2099-01-01T01:00:00.000Z')
    await caches.delete(handle)

    const files = new GoogleFileStore({ auth: CTX.auth })
    const file = await files.upload(new TextEncoder().encode('hello'), 'text/plain')
    expect(file.name).toBe('files/f1')

    const root = 'https://generativelanguage.googleapis.com'
    expect(sent.map(({ method, url }) => `${method} ${url.split('?')[0]}`)).toEqual([
      `POST ${root}/v1beta/models/${MODEL}:generateContent`,
      `POST ${root}/v1beta/models/${MODEL}:countTokens`,
      `POST ${root}/v1beta/models/${MODEL}:countTokens`,
      `POST ${root}/v1beta/cachedContents`,
      `PATCH ${root}/v1beta/cachedContents/c1`,
      `DELETE ${root}/v1beta/cachedContents/c1`,
      `POST ${root}/upload/v1beta/files`,
      `POST ${root}/upload/v1beta/files`,
    ])
    for (const call of sent) expect(call.apiKey).toBe(CALLER_KEY)
  })
})
