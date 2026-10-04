import { describe, expect, it } from 'vitest'
import { createClient, createModelRegistry } from '@gullabs/core'
import type { AdapterResult, UsageSink } from '@gullabs/core'
import { FakeAdapter } from './fake-adapter.js'
import { FakeClock } from './clock.js'
import { RecordingLogger } from './recording-logger.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

describe('RecordingLogger', () => {
  it('records every line with its level, fields and message', () => {
    const logger = new RecordingLogger()
    logger.info({ a: 1 }, 'one')
    logger.warn({ b: 2 }, 'two')
    logger.error({ c: 3 }, 'three')
    logger.debug({ d: 4 }, 'four')

    expect(logger.entries).toEqual([
      { level: 'info', fields: { a: 1 }, message: 'one' },
      { level: 'warn', fields: { b: 2 }, message: 'two' },
      { level: 'error', fields: { c: 3 }, message: 'three' },
      { level: 'debug', fields: { d: 4 }, message: 'four' },
    ])
  })

  it('filters messages by level and finds an event by name', () => {
    const logger = new RecordingLogger()
    logger.warn({ n: 1 }, 'x')
    logger.error({ n: 2 }, 'x')
    logger.error({ n: 3 }, 'y')

    expect(logger.messages()).toEqual(['x', 'x', 'y'])
    expect(logger.messages('error')).toEqual(['x', 'y'])
    expect(logger.find('x')?.fields).toEqual({ n: 1 })
    expect(logger.findAll('x').map((e) => e.level)).toEqual(['warn', 'error'])
    expect(logger.find('missing')).toBeUndefined()
  })

  it('receives the engine’s canonical events', async () => {
    const logger = new RecordingLogger()
    const clock = new FakeClock()
    const ok: AdapterResult = {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm',
      warnings: [],
    }
    const hungSink: UsageSink = { record: () => new Promise<void>(() => {}) }
    const client = createClient({
      adapters: [new FakeAdapter('google', ok)],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      logger,
      sink: hungSink,
      sinkTimeoutMs: 100,
      clock,
      scheduler: clock,
    })
    const call = client.generate(
      {
        provider: 'google',
        model: 'm',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'k' } },
    )
    await clock.advanceAsync(100)
    await call

    expect(logger.messages()).toContain('llm.call.start')
    expect(logger.messages('error')).toContain('llm.call.sink.timeout')
    expect(logger.find('llm.call.sink.timeout')?.fields).toMatchObject({
      provider: 'google',
      timeoutMs: 100,
    })
  })
})
