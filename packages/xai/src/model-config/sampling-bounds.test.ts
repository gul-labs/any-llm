import { describe, expect, it } from 'vitest'
import { Grok45ConfigSchema } from './grok-4-5.js'
import { Grok46ConfigSchema } from './grok-4-6.js'
import { Grok47ConfigSchema } from './grok-4-7.js'

describe.each([
  ['grok-4.5', Grok45ConfigSchema],
  ['grok-4.6', Grok46ConfigSchema],
  ['grok-4.7', Grok47ConfigSchema],
])('%s sampling bounds', (_model, schema) => {
  it.each([
    [{ temperature: 0 }, true],
    [{ temperature: 2 }, true],
    [{ temperature: 0.7 }, true],
    [{ temperature: -0.1 }, false],
    [{ temperature: 2.1 }, false],
    [{ temperature: Number.NaN }, false],
    [{ topP: 0 }, true],
    [{ topP: 1 }, true],
    [{ topP: 0.95 }, true],
    [{ topP: -0.01 }, false],
    [{ topP: 1.01 }, false],
    [{ topP: Number.POSITIVE_INFINITY }, false],
  ])('%j parses: %s', (config, ok) => {
    expect(schema.safeParse(config).success).toBe(ok)
  })
})
