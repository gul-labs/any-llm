/**
 * @gullabs/google — a fenced Gemma schema answer is named, not repaired.
 *
 * Gemma 4 wrapped 67 of 162 schema answers in a ```json fence in a live probe
 * (2026-10-03). The adapter returns the text as sent, `outputParsed` stays
 * false (core, from `rawStructured` being undefined), and a warning names the
 * cause. No fence is stripped.
 */

import { describe, expect, it } from 'vitest'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { fakeGeminiResponse, makeFakeGemini } from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { defaultGeminiRegistry } from './models.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}
const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

function request(model: string): ResolvedRequest {
  return {
    provider: 'google',
    model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Answer.' }] }],
    config: {},
    outputJsonSchema: SCHEMA,
    modelDescriptor: defaultGeminiRegistry.resolve('google', model)!,
  }
}

const FENCED = '```json\n{"ok":true}\n```'

describe('Gemma fenced JSON', () => {
  it('warns gemma_fenced_json, returns the text untouched and no parsed value', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: FENCED }))
    const result = await geminiAdapter({ client }).run(
      request('gemma-4-31b-it'),
      FAKE_CTX,
    )
    expect(result.text).toBe(FENCED)
    expect(result.rawStructured).toBeUndefined()
    const warning = result.warnings.map((w) => w.message).join('\n')
    expect(warning).toContain('gemma_fenced_json')
    expect(warning).toContain('gemma-4-31b-it')
    expect(warning).toContain('41%')
  })

  it('clean Gemma JSON parses and warns nothing', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: '{"ok":true}' }))
    const result = await geminiAdapter({ client }).run(
      request('gemma-4-26b-a4b-it'),
      FAKE_CTX,
    )
    expect(result.rawStructured).toEqual({ ok: true })
    expect(result.warnings).toEqual([])
  })

  it('unparseable Gemma text that is not a fence gets no fence warning', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: 'Sure! {"ok":' }))
    const result = await geminiAdapter({ client }).run(
      request('gemma-4-31b-it'),
      FAKE_CTX,
    )
    expect(result.rawStructured).toBeUndefined()
    expect(result.warnings.map((w) => w.message).join('\n')).not.toContain(
      'gemma_fenced_json',
    )
  })

  it('a fenced answer from a Gemini model is not given the Gemma warning', async () => {
    const client = makeFakeGemini(fakeGeminiResponse({ structuredJson: FENCED }))
    const result = await geminiAdapter({ client }).run(
      request('gemini-3.6-flash'),
      FAKE_CTX,
    )
    expect(result.rawStructured).toBeUndefined()
    expect(result.warnings.map((w) => w.message).join('\n')).not.toContain(
      'gemma_fenced_json',
    )
  })
})
