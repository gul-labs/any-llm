/**
 * The structured-output `name` is the schema `title`, validated against the
 * Responses API's name rule (xAI documents none; read 2026-10-03), never
 * rewritten.
 */
import { describe, expect, it } from 'vitest'
import type { AdapterCtx, JsonValue, ResolvedRequest } from '@gullabs/core'
import { fakeXaiResponse, makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok45ModelDescriptor } from './models.js'

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const schema = (extra: Record<string, JsonValue>): JsonValue => ({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
  ...extra,
})

function run(outputJsonSchema: JsonValue) {
  const client = makeFakeXai(fakeXaiResponse({ structuredJson: '{"ok":true}' }))
  const req: ResolvedRequest = {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: {},
    modelDescriptor: grok45ModelDescriptor,
    outputJsonSchema,
  }
  return { client, done: xaiAdapter({ client }).run(req, CTX) }
}

describe('structured-output name', () => {
  it.each(['Weather_Report', 'a', 'a-b_C9', 'x'.repeat(64)])(
    'sends the valid title %s as the name',
    async (title) => {
      const { client, done } = run(schema({ title }))
      await done
      const format = (client.calls[0] as { text: { format: { name: string } } }).text
        .format
      expect(format.name).toBe(title)
    },
  )

  it('sends structured_output when the schema has no title', async () => {
    const { client, done } = run(schema({}))
    await done
    expect(
      (client.calls[0] as { text: { format: { name: string } } }).text.format.name,
    ).toBe('structured_output')
  })

  it.each(['Weather Report', '', 'x'.repeat(65), 'naïve', 'a.b', 'a/b'])(
    'rejects the title %j as bad_request, before dispatch, without rewriting it',
    async (title) => {
      const { client, done } = run(schema({ title }))
      await expect(done).rejects.toMatchObject({
        kind: 'bad_request',
        retryable: false,
      })
      expect(client.calls).toHaveLength(0)
    },
  )
})
