import { describe, expect, it } from 'vitest'
import { LlmError, defineCallSite } from '@gullabs/core'
import type { CallSite, LlmRequest, TokenCount } from '@gullabs/core'
import { FakeClient } from './fake-client.js'
import { fakeLlmResult } from './fake-llm-result.js'
import { fakeHttpError } from './errors.js'

const AUTH = { apiKey: 'k' }

function request(text = 'hi', extra: Partial<LlmRequest> = {}): LlmRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text }] }],
    ...extra,
  }
}

const SITE: CallSite = defineCallSite({
  id: 'summarise',
  provider: 'google',
  model: 'gemini-2.5-pro',
  userTemplate: 'Summarise {{article}}',
})

describe('FakeClient answers', () => {
  it('returns one scripted result for every call', async () => {
    const result = fakeLlmResult({ text: 'a' })
    const client = new FakeClient(result)
    expect(await client.generate(request(), { auth: AUTH })).toBe(result)
    expect(await client.generate(request(), { auth: AUTH })).toBe(result)
  })

  it('consumes a list in order and repeats the last entry', async () => {
    const a = fakeLlmResult({ text: 'a' })
    const b = fakeLlmResult({ text: 'b' })
    const client = new FakeClient([a, fakeHttpError(503), b])

    expect(await client.generate(request(), { auth: AUTH })).toBe(a)
    // An Error entry arrives as an LlmError, the original as its cause.
    await expect(client.generate(request(), { auth: AUTH })).rejects.toMatchObject({
      kind: 'server',
      httpStatus: 503,
      cause: { status: 503 },
    })
    expect(await client.generate(request(), { auth: AUTH })).toBe(b)
    expect(await client.generate(request(), { auth: AUTH })).toBe(b)
  })

  it('runStructured answers from the same script, with or without vars', async () => {
    const a = fakeLlmResult({ text: 'a' })
    const b = fakeLlmResult({ text: 'b' })
    const client = new FakeClient([a, b])

    expect(await client.runStructured(SITE, { auth: AUTH })).toBe(a)
    expect(await client.runStructured(SITE, { article: 'x' }, { auth: AUTH })).toBe(b)
    expect(client.calls[0]).toMatchObject({ method: 'runStructured', request: SITE })
    expect(client.calls[0]).not.toHaveProperty('vars')
    expect(client.calls[1]).toMatchObject({
      method: 'runStructured',
      vars: { article: 'x' },
    })
  })

  it('an already-aborted signal is refused as aborted, without consuming the script', async () => {
    const result = fakeLlmResult()
    const client = new FakeClient([result])
    const controller = new AbortController()
    controller.abort()

    const error = await client
      .generate(request(), { auth: AUTH, signal: controller.signal })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'aborted', retryable: false })
    expect(await client.generate(request(), { auth: AUTH })).toBe(result)
  })

  it('countTokens needs a scripted answer, then repeats the last', async () => {
    const count: TokenCount = { totalTokens: 12, accuracy: 'exact', raw: {} }
    const client = new FakeClient(fakeLlmResult(), {
      countTokens: [count, fakeHttpError(500)],
    })
    const req = {
      provider: 'google',
      model: 'gemini-2.5-pro',
      messages: request().messages,
    }

    expect(await client.countTokens(req, { auth: AUTH })).toBe(count)
    for (let i = 0; i < 2; i++) {
      await expect(client.countTokens(req, { auth: AUTH })).rejects.toMatchObject({
        kind: 'server',
        httpStatus: 500,
        cause: { status: 500 },
      })
    }
    expect(client.calls.map((c) => c.method)).toEqual([
      'countTokens',
      'countTokens',
      'countTokens',
    ])

    await expect(
      new FakeClient(fakeLlmResult()).countTokens(req, { auth: AUTH }),
    ).rejects.toThrow(/no `countTokens` answer was scripted/)
  })
})

describe('FakeClient rejects an invalid script', () => {
  it('a plain object, a half-built result and an empty list are TypeErrors naming the entry', () => {
    expect(() => new FakeClient({ status: 500 } as never)).toThrow(TypeError)
    expect(() => new FakeClient({ status: 500 } as never)).toThrow(
      /entry 0 is not a complete LlmResult \(missing message, continuation, usage/,
    )
    expect(() => new FakeClient([fakeLlmResult(), 'x' as never])).toThrow(
      /entry 1 must be an Error or an LlmResult/,
    )
    expect(() => new FakeClient([])).toThrow(/at least one scripted entry/)
  })

  it('a result built by hand without callCost-independent required fields is refused', () => {
    const { message: _message, ...noMessage } = fakeLlmResult()
    expect(() => new FakeClient(noMessage as never)).toThrow(/missing message/)
    const { continuation: _continuation, ...noContinuation } = fakeLlmResult()
    expect(() => new FakeClient(noContinuation as never)).toThrow(/missing continuation/)
  })
})

describe('FakeClient request capture and expectRequest', () => {
  it('records every call with the request exactly as sent', async () => {
    const client = new FakeClient(fakeLlmResult())
    const req = request('hello')
    await client.generate(req, { auth: AUTH })
    await client.runStructured(SITE, { article: 'a' }, { auth: AUTH })

    expect(client.calls).toHaveLength(2)
    expect(client.calls[0]!.request).toBe(req)
    expect(client.calls[0]).toMatchObject({ method: 'generate', opts: { auth: AUTH } })
  })

  it('expectRequest passes on a subset match, nested, against the last call by default', async () => {
    const client = new FakeClient(fakeLlmResult())
    await client.generate(request('first'), { auth: AUTH })
    await client.generate(request('second', { config: { temperature: 0.2 } }), {
      auth: AUTH,
    })

    expect(() =>
      client.expectRequest({
        provider: 'google',
        config: { temperature: 0.2 },
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'second' }] }],
      }),
    ).not.toThrow()
    expect(() =>
      client.expectRequest({ messages: [{ parts: [{ text: 'first' }] }] }, { call: 0 }),
    ).not.toThrow()
  })

  it('expectRequest throws with both sides shown when a field differs', async () => {
    const client = new FakeClient(fakeLlmResult())
    await client.generate(request('hello'), { auth: AUTH })

    expect(() => client.expectRequest({ model: 'gpt' })).toThrow(
      /call 0 \(generate\) does not match/,
    )
    expect(() => client.expectRequest({ model: 'gpt' })).toThrow(/"model": "gpt"/)
    expect(() => client.expectRequest({ model: 'gpt' })).toThrow(
      /"model": "gemini-2.5-pro"/,
    )
  })

  it('arrays must match in length and element by element', async () => {
    const client = new FakeClient(fakeLlmResult())
    await client.generate(request('a'), { auth: AUTH })

    expect(() => client.expectRequest({ messages: [] })).toThrow(/does not match/)
    expect(() =>
      client.expectRequest({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'a' }] },
          { role: 'user' },
        ],
      }),
    ).toThrow(/does not match/)
  })

  it('expectRequest with no such call throws, naming how many there were', () => {
    const client = new FakeClient(fakeLlmResult())
    expect(() => client.expectRequest({ model: 'x' })).toThrow(/there is no call -1/)
    expect(() => client.expectRequest({ model: 'x' }, { call: 3 })).toThrow(
      /no call 3 \(the client received 0\)/,
    )
  })

  it('works on a runStructured call site', async () => {
    const client = new FakeClient(fakeLlmResult())
    await client.runStructured(SITE, { article: 'a' }, { auth: AUTH })
    expect(() =>
      client.expectRequest({ id: 'summarise', provider: 'google' }),
    ).not.toThrow()
  })
})
