import { describe, it, expect } from 'vitest'
import { FakeAdapter } from './fake-adapter.js'
import { FakeClock } from './clock.js'
import type { AdapterResult, AdapterCtx, ResolvedRequest, Usage } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

const STUB_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  details: {},
  raw: {},
}

function makeSuccessResult(): AdapterResult {
  return {
    message: { role: 'assistant', parts: [] },
    model: 'fake-model',
    usage: STUB_USAGE,
    warnings: [],
  }
}

const STUB_REQ: ResolvedRequest = {
  provider: 'fake',
  model: 'fake-model',
  messages: [],
  config: { serviceTier: 'flex' },
}

const STUB_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FakeAdapter', () => {
  it('returns scripted AdapterResult as success', async () => {
    const result = makeSuccessResult()
    const adapter = new FakeAdapter('fake', result)

    const returned = await adapter.run(STUB_REQ, STUB_CTX)

    expect(returned).toBe(result)
  })

  it('rejects a result entry without the required assistant message, and never rebuilds one from text', () => {
    const { message: _omitted, ...withoutMessage } = makeSuccessResult()
    expect(
      () =>
        new FakeAdapter('fake', {
          ...withoutMessage,
          text: 'hi',
        } as unknown as AdapterResult),
    ).toThrow(/needs `message`/)
    expect(
      () =>
        new FakeAdapter('fake', {
          ...makeSuccessResult(),
          message: { role: 'user' },
        } as unknown as AdapterResult),
    ).toThrow(/needs `message`/)
    // Errors are scripted throws.
    expect(() => new FakeAdapter('fake', new Error('boom'))).not.toThrow()
  })

  it('throws a scripted Error instance', async () => {
    const err = new Error('boom')
    const adapter = new FakeAdapter('fake', err)

    await expect(adapter.run(STUB_REQ, STUB_CTX)).rejects.toThrow('boom')
  })

  it('rejects a plain object instead of throwing it as an error', () => {
    const plain = { status: 429 } as unknown as Error
    expect(() => new FakeAdapter('fake', plain)).toThrow(TypeError)
    expect(() => new FakeAdapter('fake', plain)).toThrow(
      /entry 0 must be an Error or an AdapterResult/,
    )
    expect(() => new FakeAdapter('fake', plain)).toThrow(/fakeHttpError/)
  })

  it('rejects a mistyped result object (usage: null, missing model) instead of throwing it', () => {
    const mistyped = { status: 429, usage: null } as unknown as Error
    expect(() => new FakeAdapter('fake', mistyped)).toThrow(
      /lacks a non-empty `model` and a `usage` object/,
    )
    const { model: _model, ...noModel } = makeSuccessResult()
    expect(() => new FakeAdapter('fake', noModel as unknown as AdapterResult)).toThrow(
      /lacks a non-empty `model`/,
    )
    const { usage: _usage, ...noUsage } = makeSuccessResult()
    expect(() => new FakeAdapter('fake', noUsage as unknown as AdapterResult)).toThrow(
      /lacks a `usage` object/,
    )
  })

  it('names the position of the bad entry in a list, and refuses an empty list', () => {
    expect(
      () => new FakeAdapter('fake', [makeSuccessResult(), 'oops' as unknown as Error]),
    ).toThrow(/entry 1 must be an Error or an AdapterResult, got string/)
    expect(() => new FakeAdapter('fake', [])).toThrow(/at least one scripted entry/)
  })

  it('a delay runs on the scheduler in the context, so a FakeClock makes it deterministic', async () => {
    const clock = new FakeClock()
    const adapter = new FakeAdapter('fake', makeSuccessResult(), { delayMs: 5_000 })
    let settled = false
    const pending = adapter.run(STUB_REQ, { ...STUB_CTX, scheduler: clock }).then((r) => {
      settled = true
      return r
    })

    await clock.advanceAsync(4_999)
    expect(settled).toBe(false)
    await clock.advanceAsync(1)
    expect(settled).toBe(true)
    await expect(pending).resolves.toMatchObject({ model: 'fake-model' })
    expect(clock.pendingTimers).toBe(0)
  })

  it('records calls', async () => {
    const adapter = new FakeAdapter('fake', makeSuccessResult())

    expect(adapter.calls).toHaveLength(0)

    await adapter.run(STUB_REQ, STUB_CTX)
    expect(adapter.calls).toHaveLength(1)

    await adapter.run(STUB_REQ, STUB_CTX)
    expect(adapter.calls).toHaveLength(2)
  })
})
