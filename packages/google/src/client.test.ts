/**
 * buildGoogleClient unit tests.
 *
 * buildGoogleClient is the only place in this package that imports the real
 * @google/genai SDK, so it is exercised here with a mocked module instead of
 * a hand-rolled fake (see the module doc comment at the top of client.ts).
 * Every other test in this package injects a fake GeminiClientLike directly.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { buildGoogleClient } from './client.js'
import type { GeminiGenerateParams, GeminiResponseShape } from './client.js'

// ---------------------------------------------------------------------------
// Mock @google/genai — vi.mock factories are hoisted above imports, so all
// state must be created inside the factory via vi.hoisted.
// ---------------------------------------------------------------------------

const { constructorCalls, generateContentMock } = vi.hoisted(() => {
  return {
    constructorCalls: [] as unknown[],
    generateContentMock: vi.fn(),
  }
})

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models: {
      generateContent: typeof generateContentMock
    }
    constructor(args: unknown) {
      constructorCalls.push(args)
      this.models = { generateContent: generateContentMock }
    }
  }
  return { GoogleGenAI }
})

describe('buildGoogleClient', () => {
  it('constructs GoogleGenAI with the auth key and the pinned Developer API base URL, nothing else', async () => {
    constructorCalls.length = 0

    await buildGoogleClient({ apiKey: 'test-key' })

    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]).toEqual({
      apiKey: 'test-key',
      httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com/' },
    })
  })

  it('models.generateContent delegates to the underlying SDK client and returns its result unchanged', async () => {
    constructorCalls.length = 0
    const fakeResponse: GeminiResponseShape = {
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    }
    generateContentMock.mockReset().mockResolvedValue(fakeResponse)

    const client = await buildGoogleClient({ apiKey: 'test-key' })

    const params: GeminiGenerateParams = {
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }
    const result = await client.models.generateContent(params)

    expect(generateContentMock).toHaveBeenCalledTimes(1)
    expect(generateContentMock).toHaveBeenCalledWith(params)
    expect(result).toBe(fakeResponse)
  })
})
