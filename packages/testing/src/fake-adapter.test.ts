import { describe, it, expect } from 'vitest'
import { FakeAdapter } from './fake-adapter.js'
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
    expect(() => new FakeAdapter('fake', { ...withoutMessage, text: 'hi' })).toThrow(
      /needs `message`/,
    )
    expect(
      () =>
        new FakeAdapter('fake', { ...makeSuccessResult(), message: { role: 'user' } }),
    ).toThrow(/needs `message`/)
    // Errors and HTTP-style objects are still scripted throws.
    expect(() => new FakeAdapter('fake', new Error('boom'))).not.toThrow()
    expect(() => new FakeAdapter('fake', { status: 429 })).not.toThrow()
  })

  it('throws a scripted Error instance', async () => {
    const err = new Error('boom')
    const adapter = new FakeAdapter('fake', err)

    await expect(adapter.run(STUB_REQ, STUB_CTX)).rejects.toThrow('boom')
  })

  it('throws a plain-object error with status only', async () => {
    const plainErr = { status: 429 }
    const adapter = new FakeAdapter('fake', plainErr)

    await expect(adapter.run(STUB_REQ, STUB_CTX)).rejects.toEqual({ status: 429 })
  })

  it('throws plain-object error with status AND usage: null (the bug case)', async () => {
    const plainErr = { status: 429, usage: null }
    const adapter = new FakeAdapter('fake', plainErr)

    // Before the fix, usage: null would have caused this to be returned as
    // a success result. After the fix it must be thrown.
    await expect(adapter.run(STUB_REQ, STUB_CTX)).rejects.toEqual({
      status: 429,
      usage: null,
    })
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
