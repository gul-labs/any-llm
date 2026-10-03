import { describe, expect, it } from 'vitest'
import { XAI_MAX_TIMEOUT_MS, XAI_TIMEOUT_BUFFER_MS } from '../client.js'
import { Grok45ConfigSchema } from './grok-4-5.js'
import { Grok46ConfigSchema } from './grok-4-6.js'
import { Grok47ConfigSchema } from './grok-4-7.js'

// Node timers overflow above 2^31 - 1 ms and fire after 1 ms. The SDK deadline
// is `timeoutMs + XAI_TIMEOUT_BUFFER_MS`, so a `timeoutMs` the engine can arm
// can still overflow the SDK's timer: reject it rather than clamp it.
const MAX_TIMER_MS = 2_147_483_647

describe.each([
  ['grok-4.5', Grok45ConfigSchema],
  ['grok-4.6', Grok46ConfigSchema],
  ['grok-4.7', Grok47ConfigSchema],
])('%s timeoutMs upper bound', (_name, schema) => {
  it('the limit leaves room for the SDK buffer under the timer maximum', () => {
    expect(XAI_MAX_TIMEOUT_MS + XAI_TIMEOUT_BUFFER_MS).toBe(MAX_TIMER_MS)
  })

  it('accepts the largest timeoutMs whose SDK deadline still fits a timer', () => {
    expect(schema.safeParse({ timeoutMs: XAI_MAX_TIMEOUT_MS }).success).toBe(true)
  })

  it('rejects a timeoutMs whose SDK deadline would overflow the timer', () => {
    expect(schema.safeParse({ timeoutMs: XAI_MAX_TIMEOUT_MS + 1 }).success).toBe(false)
    expect(schema.safeParse({ timeoutMs: MAX_TIMER_MS }).success).toBe(false)
  })
})
