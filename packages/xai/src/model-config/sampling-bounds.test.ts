import { describe, expect, it } from 'vitest'
import { createClient } from '@gullabs/core'
import { FakeClock, FakeIds, fakeXaiResponse, makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from '../adapter.js'
import { xaiRegistry } from '../models.js'
import { xaiPricingSource } from '../pricing.js'
import { Grok45ConfigSchema } from './grok-4-5.js'
import { Grok46ConfigSchema } from './grok-4-6.js'
import { Grok47ConfigSchema } from './grok-4-7.js'

/**
 * xAI's Responses API reference (read 2026-11-20) says a `temperature` above 1
 * is sampled as 1 and a `top_p` above the model default 0.95 is sampled as 0.95,
 * while the response echoes the value sent. Under reject-don't-map the schema
 * admits only values xAI samples as sent.
 */
describe.each([
  ['grok-4.5', Grok45ConfigSchema],
  ['grok-4.6', Grok46ConfigSchema],
  ['grok-4.7', Grok47ConfigSchema],
])('%s sampling bounds', (_model, schema) => {
  it.each([
    [{ temperature: 0 }, true],
    [{ temperature: 0.7 }, true],
    [{ temperature: 1 }, true],
    [{ temperature: 1.0001 }, false],
    [{ temperature: 2 }, false],
    [{ temperature: -0.1 }, false],
    [{ temperature: Number.NaN }, false],
    [{ topP: 0 }, true],
    [{ topP: 0.9 }, true],
    [{ topP: 0.95 }, true],
    [{ topP: 0.9501 }, false],
    [{ topP: 1 }, false],
    [{ topP: -0.01 }, false],
    [{ topP: Number.POSITIVE_INFINITY }, false],
  ])('%j parses: %s', (config, ok) => {
    expect(schema.safeParse(config).success).toBe(ok)
  })

  it('names the offending path when temperature is above 1', () => {
    const result = schema.safeParse({ temperature: 1.0001 })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['temperature']])
  })

  it('names the offending path when topP is above 0.95', () => {
    const result = schema.safeParse({ topP: 0.9501 })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['topP']])
  })
})

describe.each(['grok-4.5', 'grok-4.6', 'grok-4.7'] as const)(
  '%s through the client',
  (model) => {
    const dispatch = async (config: Record<string, unknown>) => {
      const fake = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
      const client = createClient({
        adapters: [xaiAdapter({ client: fake })],
        pricingSources: { xai: xaiPricingSource() },
        modelRegistry: xaiRegistry,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })
      const outcome = await client
        .generate(
          {
            provider: 'xai',
            model,
            messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
            config,
          },
          { auth: { apiKey: 'test-key' } },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      return { outcome, calls: fake.calls }
    }

    it.each([{ temperature: 2 }, { topP: 1 }])(
      'rejects %j as bad_request before dispatch',
      async (config) => {
        const { outcome, calls } = await dispatch(config)
        expect(outcome).toMatchObject({ kind: 'bad_request' })
        expect(calls).toHaveLength(0)
      },
    )

    it('sends the boundary values verbatim', async () => {
      const { outcome, calls } = await dispatch({ temperature: 1, topP: 0.95 })
      expect(outcome).toBeUndefined()
      expect(calls[0]).toMatchObject({ temperature: 1, top_p: 0.95 })
    })
  },
)
