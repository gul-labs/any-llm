import { describe, expect, it } from 'vitest'
import { createClient, createModelRegistry, retryMiddleware } from '@gullabs/core'
import type { AdapterResult } from '@gullabs/core'
import { FakeAdapter } from './fake-adapter.js'
import { FakeClock } from './clock.js'
import { fakeHttpError } from './errors.js'
import { RecordingTelemetry } from './recording-telemetry.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'm',
  warnings: [],
}

const registry = createModelRegistry([
  makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
])
const request = {
  provider: 'google',
  model: 'm',
  messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }],
}

describe('RecordingTelemetry', () => {
  it('records start, one attempt per provider attempt, and success, sharing one span', async () => {
    const telemetry = new RecordingTelemetry()
    const clock = new FakeClock()
    const client = createClient({
      adapters: [new FakeAdapter('google', [fakeHttpError(503), OK])],
      modelRegistry: registry,
      telemetry,
      clock,
      scheduler: clock,
      middleware: [retryMiddleware({ baseDelayMs: 0 })],
    })

    const call = client.generate(request, { auth: { apiKey: 'k' } })
    await clock.advanceAsync(0) // the retry back-off is a timer on the fake clock
    await call

    expect(telemetry.starts).toHaveLength(1)
    expect(telemetry.attempts).toHaveLength(2)
    expect(telemetry.attempts.map((a) => a.attemptNumber)).toEqual([1, 2])
    expect(telemetry.successes).toHaveLength(1)
    expect(telemetry.errors).toEqual([])
    expect(telemetry.events.map((e) => e.type)).toEqual([
      'start',
      'attempt',
      'attempt',
      'success',
    ])
    const spans = telemetry.events.flatMap((e) => (e.type === 'start' ? [] : [e.span]))
    expect(new Set(spans.map((s) => JSON.stringify(s))).size).toBe(1)
    expect(spans[0]).toEqual({ span: 1 })
  })

  it('records the failure event of a call that fails', async () => {
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [new FakeAdapter('google', fakeHttpError(400))],
      modelRegistry: registry,
      telemetry,
    })

    await expect(
      client.generate(request, { auth: { apiKey: 'k' } }),
    ).rejects.toBeDefined()

    expect(telemetry.errors).toHaveLength(1)
    expect(telemetry.errors[0]).toMatchObject({ errorKind: 'bad_request' })
    expect(telemetry.successes).toEqual([])
  })

  it('gives each call its own span handle', async () => {
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: registry,
      telemetry,
    })
    await client.generate(request, { auth: { apiKey: 'k' } })
    await client.generate(request, { auth: { apiKey: 'k' } })

    const successSpans = telemetry.events.flatMap((e) =>
      e.type === 'success' ? [e.span] : [],
    )
    expect(successSpans).toEqual([{ span: 1 }, { span: 2 }])
  })
})
