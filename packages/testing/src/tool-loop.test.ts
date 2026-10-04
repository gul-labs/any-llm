import { describe, expect, it } from 'vitest'
import type { GenerateOptions, LlmRequest, LlmResult, Message } from '@gullabs/core'
import { runToolLoop } from './tool-loop.js'

const AUTH: GenerateOptions = { auth: { apiKey: 'k' } }
const USER: Message = { role: 'user', parts: [{ kind: 'text', text: 'go' }] }

function result(overrides: Partial<LlmResult>): LlmResult {
  return {
    callId: 'c',
    attemptId: 'a',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'm',
    latencyMs: 0,
    warnings: [],
    message: { role: 'assistant', parts: [] },
    continuation: 'history',
    ...overrides,
  }
}
const call = (id: string) => ({ toolCallId: id, toolName: 'echo', args: { id } })
const callMessage = (id: string): Message => ({
  role: 'assistant',
  parts: [{ kind: 'tool-call', ...call(id) }],
})

function scripted(results: LlmResult[]) {
  const requests: LlmRequest[] = []
  return {
    requests,
    client: {
      async generate(request: LlmRequest): Promise<LlmResult> {
        requests.push(structuredClone(request))
        const next = results.shift()
        if (next === undefined) throw new Error('script exhausted')
        return next
      },
    },
  }
}
const REQ: LlmRequest = { provider: 'p', model: 'm', messages: [USER] }
const tools = { echo: (args: unknown) => ({ echoed: args as { id: string } }) }

describe('runToolLoop', () => {
  it("'history': appends result.message and the tool results, resends the full history", async () => {
    const { client, requests } = scripted([
      result({
        toolCalls: [call('1')],
        message: callMessage('1'),
        transientProviderState: { p: 1 },
      }),
      result({
        toolCalls: [call('2')],
        message: callMessage('2'),
        transientProviderState: { p: 2 },
      }),
      result({ text: 'done' }),
    ])
    const outcome = await runToolLoop(client, REQ, tools, AUTH)
    expect(outcome.result.text).toBe('done')
    expect(outcome.turns).toHaveLength(3)
    expect(requests.map((r) => r.messages.length)).toEqual([1, 3, 5])
    expect(requests[0]?.transientProviderState).toBeUndefined()
    expect(requests[1]?.messages[1]).toEqual(callMessage('1'))
    expect(requests[1]?.messages[2]).toEqual({
      role: 'user',
      parts: [
        {
          kind: 'tool-result',
          toolCallId: '1',
          toolName: 'echo',
          result: { echoed: { id: '1' } },
        },
      ],
    })
    expect(requests.map((r) => r.transientProviderState)).toEqual([
      undefined,
      { p: 1 },
      { p: 2 },
    ])
  })

  it("'state': sends only the new tool results plus the state, never result.message", async () => {
    const { client, requests } = scripted([
      result({
        continuation: 'state',
        toolCalls: [call('1')],
        message: callMessage('1'),
        transientProviderState: { p: 1 },
      }),
      result({
        continuation: 'state',
        toolCalls: [call('2')],
        message: callMessage('2'),
        transientProviderState: { p: 2 },
      }),
      result({ continuation: 'state', text: 'done' }),
    ])
    await runToolLoop(client, REQ, tools, AUTH)
    expect(requests.map((r) => r.messages.length)).toEqual([1, 1, 1])
    expect(requests[1]?.messages[0]?.role).toBe('user')
    expect(requests[2]?.messages[0]?.parts[0]).toMatchObject({ toolCallId: '2' })
    expect(requests.map((r) => r.transientProviderState)).toEqual([
      undefined,
      { p: 1 },
      { p: 2 },
    ])
    expect(JSON.stringify(requests)).not.toContain('"role":"assistant"')
  })

  it("'state' without a state is a helper error, not a silent history replay", async () => {
    const { client } = scripted([
      result({
        continuation: 'state',
        toolCalls: [call('1')],
        message: callMessage('1'),
      }),
    ])
    await expect(runToolLoop(client, REQ, tools, AUTH)).rejects.toThrow(
      /requires result.transientProviderState/,
    )
  })

  it('executes parallel calls in one results message, in order', async () => {
    const { client, requests } = scripted([
      result({ toolCalls: [call('1'), call('2')], message: callMessage('1') }),
      result({ text: 'done' }),
    ])
    await runToolLoop(client, REQ, tools, AUTH)
    expect(
      requests[1]?.messages[2]?.parts.map(
        (p) => (p as { toolCallId: string }).toolCallId,
      ),
    ).toEqual(['1', '2'])
  })

  it('throws for a tool with no implementation and for runaway loops', async () => {
    const missing = scripted([
      result({ toolCalls: [{ toolCallId: '1', toolName: 'nope', args: {} }] }),
    ])
    await expect(runToolLoop(missing.client, REQ, tools, AUTH)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      message: expect.stringMatching(/no implementation for tool "nope"/),
    })
    const endless = scripted(
      Array.from({ length: 5 }, () =>
        result({ toolCalls: [call('1')], message: callMessage('1') }),
      ),
    )
    await expect(
      runToolLoop(endless.client, REQ, tools, { ...AUTH, maxTurns: 3 }),
    ).rejects.toThrow(/after 3 turns/)
    expect(endless.requests).toHaveLength(3)
  })

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'a model call named %s is a missing tool, not an inherited Object.prototype function',
    async (name) => {
      const inherited = scripted([
        result({ toolCalls: [{ toolCallId: '1', toolName: name, args: {} }] }),
      ])
      await expect(runToolLoop(inherited.client, REQ, tools, AUTH)).rejects.toMatchObject(
        {
          kind: 'bad_request',
          message: expect.stringContaining(`no implementation for tool "${name}"`),
        },
      )
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxTurns %s is bad_request before any model call',
    async (maxTurns) => {
      const { client, requests } = scripted([result({ text: 'unused' })])
      await expect(
        runToolLoop(client, REQ, tools, { ...AUTH, maxTurns }),
      ).rejects.toMatchObject({ name: 'LlmError', kind: 'bad_request' })
      expect(requests).toHaveLength(0)
    },
  )

  it('a throwing tool becomes an isError tool result and the loop continues', async () => {
    const { client, requests } = scripted([
      result({
        toolCalls: [call('1'), call('2')],
        message: callMessage('1'),
        transientProviderState: { p: 1 },
      }),
      result({ text: 'recovered' }),
    ])
    const flaky = {
      echo: (args: unknown) => {
        if ((args as { id: string }).id === '1') throw new Error('upstream 503')
        return { ok: true }
      },
    }
    const outcome = await runToolLoop(client, REQ, flaky, AUTH)
    expect(outcome.result.text).toBe('recovered')
    expect(requests[1]?.messages[2]?.parts).toEqual([
      {
        kind: 'tool-result',
        toolCallId: '1',
        toolName: 'echo',
        result: 'upstream 503',
        isError: true,
      },
      { kind: 'tool-result', toolCallId: '2', toolName: 'echo', result: { ok: true } },
    ])
  })

  it('a tool that rejects with a non-Error is reported by its string form', async () => {
    const { client, requests } = scripted([
      result({ toolCalls: [call('1')], message: callMessage('1') }),
      result({ text: 'done' }),
    ])
    await runToolLoop(
      client,
      REQ,
      {
        echo: () => {
          throw 'plain string'
        },
      },
      AUTH,
    )
    expect(requests[1]?.messages[2]?.parts[0]).toMatchObject({
      result: 'plain string',
      isError: true,
    })
  })

  it('does not mutate the request it was given', async () => {
    const { client } = scripted([
      result({
        toolCalls: [call('1')],
        message: callMessage('1'),
        transientProviderState: { p: 1 },
      }),
      result({ text: 'done' }),
    ])
    const req: LlmRequest = { ...REQ, messages: [USER] }
    await runToolLoop(client, req, tools, AUTH)
    expect(req.messages).toEqual([USER])
    expect(req.transientProviderState).toBeUndefined()
  })
})
