import { describe, expect, it } from 'vitest'
import { GOOGLE_MAX_TIMEOUT_MS, TRANSPORT_TIMEOUT_BUFFER_MS } from '../client.js'
import { Gemini25FlashLiteConfigSchema } from './gemini-2.5-flash-lite.js'
import { Gemini25FlashConfigSchema } from './gemini-2.5-flash.js'
import { Gemini25ProConfigSchema } from './gemini-2.5-pro.js'
import { Gemini31FlashLiteConfigSchema } from './gemini-3.1-flash-lite.js'
import { Gemini31ProPreviewConfigSchema } from './gemini-3.1-pro-preview.js'
import { Gemini35FlashLiteConfigSchema } from './gemini-3.5-flash-lite.js'
import { Gemini36FlashConfigSchema } from './gemini-3.6-flash.js'
import { Gemini37FlashConfigSchema } from './gemini-3.7-flash.js'
import { Gemini38FlashConfigSchema } from './gemini-3.8-flash.js'
import { Gemma426bA4bItConfigSchema } from './gemma-4-26b-a4b-it.js'
import { Gemma431bItConfigSchema } from './gemma-4-31b-it.js'

// Node timers overflow above 2^31 - 1 ms and fire after 1 ms. The SDK deadline
// is `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS`, so a `timeoutMs` the engine can
// arm can still overflow the SDK's timer: reject it rather than clamp it.
const MAX_TIMER_MS = 2_147_483_647

describe.each([
  ['gemini-2.5-flash-lite', Gemini25FlashLiteConfigSchema],
  ['gemini-2.5-flash', Gemini25FlashConfigSchema],
  ['gemini-2.5-pro', Gemini25ProConfigSchema],
  ['gemini-3.1-flash-lite', Gemini31FlashLiteConfigSchema],
  ['gemini-3.1-pro-preview', Gemini31ProPreviewConfigSchema],
  ['gemini-3.5-flash-lite', Gemini35FlashLiteConfigSchema],
  ['gemini-3.6-flash', Gemini36FlashConfigSchema],
  ['gemini-3.7-flash', Gemini37FlashConfigSchema],
  ['gemini-3.8-flash', Gemini38FlashConfigSchema],
  ['gemma-4-26b-a4b-it', Gemma426bA4bItConfigSchema],
  ['gemma-4-31b-it', Gemma431bItConfigSchema],
])('%s timeoutMs upper bound', (_name, schema) => {
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
