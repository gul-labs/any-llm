import { describe, expect, it } from 'vitest'
import { GOOGLE_MAX_TIMEOUT_MS, TRANSPORT_TIMEOUT_BUFFER_MS } from '../client.js'
import { defaultGeminiRegistry } from '../models.js'

// Node timers overflow above 2^31 - 1 ms and fire after 1 ms. The SDK deadline
// is `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS`, so a `timeoutMs` the engine can
// arm can still overflow the SDK's timer: reject it rather than clamp it.
const MAX_TIMER_MS = 2_147_483_647

// Every registered model's schema, so a model added to the registry is covered.
describe.each(
  defaultGeminiRegistry
    .listDescriptors()
    .map((descriptor) => [descriptor.model, descriptor.configSchema] as const),
)('%s timeoutMs upper bound', (_name, schema) => {
  it('the limit leaves room for the SDK buffer under the timer maximum', () => {
    expect(GOOGLE_MAX_TIMEOUT_MS + TRANSPORT_TIMEOUT_BUFFER_MS).toBe(MAX_TIMER_MS)
  })

  it('accepts the largest timeoutMs whose SDK deadline still fits a timer', () => {
    expect(schema.safeParse({ timeoutMs: GOOGLE_MAX_TIMEOUT_MS }).success).toBe(true)
  })

  it('rejects a timeoutMs whose SDK deadline would overflow the timer', () => {
    expect(schema.safeParse({ timeoutMs: GOOGLE_MAX_TIMEOUT_MS + 1 }).success).toBe(false)
    expect(schema.safeParse({ timeoutMs: MAX_TIMER_MS }).success).toBe(false)
  })
})
