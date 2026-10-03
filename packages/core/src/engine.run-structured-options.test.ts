/**
 * `runStructured` option parity with `generate` (R6): `externalId`,
 * `attachments`, `history` and `transientProviderState` reach the adapter and
 * the record, and an empty rendered user message with no attachments is
 * refused. Output validation stays with the host (ADR-009): none of these
 * options changes what the engine does with the result.
 */
import { describe, expect, it } from 'vitest'
import { FakeAdapter, RecordingSink } from '@gullabs/testing'

import {
  createClient,
  createModelRegistry,
  defineCallSite,
  LlmError,
  retryMiddleware,
} from './index.js'
import type { AdapterResult, Message, Part, Usage } from './index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const USAGE: Usage = { inputTokens: 1, outputTokens: 1, details: {}, raw: null }
const AUTH = { apiKey: 'k' }

function ok(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    usage: USAGE,
    model: 'm',
    warnings: [],
    ...overrides,
  }
}

function setup(
  entries: AdapterResult | Array<AdapterResult | LlmError> = ok(),
  opts: { providerState?: boolean; retry?: boolean } = {},
) {
  const adapter = new FakeAdapter('p', entries as AdapterResult | AdapterResult[])
  const sink = new RecordingSink()
  const client = createClient({
    adapters: [adapter],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({
        model: 'm',
        provider: 'p',
        ...(opts.providerState === true ? { capabilities: { providerState: true } } : {}),
      }),
      makePermissiveTestDescriptor({ model: 'plain', provider: 'p' }),
    ]),
    sink,
    ...(opts.retry === true
      ? { middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })] }
      : {}),
  })
  return { adapter, sink, client }
}

const site = defineCallSite({
  id: 'site',
  provider: 'p',
  model: 'm',
  system: 'Be brief, {{who}}.',
  userTemplate: 'Review {{what}}',
})
const VARS = { who: 'Ann', what: 'this' }
const PDF: Part = {
  kind: 'file-uri',
  uri: 'https://x.test/a.pdf',
  mimeType: 'application/pdf',
}
const IMAGE: Part = { kind: 'inline-media', mimeType: 'image/png', data: 'AAAA' }

describe('runStructured option parity', () => {
  it('externalId is persisted on the record', async () => {
    const { sink, client } = setup()
    await client.runStructured(site, VARS, { auth: AUTH, externalId: 'op-42' })
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.externalId).toBe('op-42')
  })

  it('externalId is persisted on every attempt row of a retried call', async () => {
    const { sink, client } = setup(
      [new LlmError('busy', { kind: 'server', retryable: true }), ok()],
      { retry: true },
    )
    await client.runStructured(site, VARS, { auth: AUTH, externalId: 'op-7' })
    expect(sink.records.map((r) => r.externalId)).toEqual(['op-7', 'op-7'])
    expect(sink.records).toHaveLength(2)
  })

  it('without externalId the record carries none', async () => {
    const { sink, client } = setup()
    await client.runStructured(site, VARS, { auth: AUTH })
    expect(sink.records[0]).not.toHaveProperty('externalId')
  })

  it('attachments are appended after the rendered text, in order', async () => {
    const { adapter, client } = setup()
    await client.runStructured(site, VARS, { auth: AUTH, attachments: [PDF, IMAGE] })
    expect(adapter.calls[0]?.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'Review this' }, PDF, IMAGE] },
    ])
    expect(adapter.calls[0]?.system).toBe('Be brief, Ann.')
  })

  it('an empty attachments array is the same as none', async () => {
    const { adapter, client } = setup()
    await client.runStructured(site, VARS, { auth: AUTH, attachments: [] })
    expect(adapter.calls[0]?.messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'Review this' }] },
    ])
  })

  it('attachments alone make a valid message when the template renders nothing', async () => {
    const { adapter, client } = setup()
    const bare = defineCallSite({ id: 'bare', provider: 'p', model: 'm' })
    await client.runStructured(bare, { auth: AUTH, attachments: [PDF] })
    expect(adapter.calls[0]?.messages).toEqual([{ role: 'user', parts: [PDF] }])
  })

  it('history is prepended unchanged, before the rendered user message', async () => {
    const { adapter, client } = setup()
    const history: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'earlier question' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'earlier answer' }] },
    ]
    const before = JSON.stringify(history)
    await client.runStructured(site, VARS, { auth: AUTH, history, attachments: [PDF] })
    expect(adapter.calls[0]?.messages).toEqual([
      ...history,
      { role: 'user', parts: [{ kind: 'text', text: 'Review this' }, PDF] },
    ])
    expect(JSON.stringify(history)).toBe(before)
    expect(history).toHaveLength(2)
  })

  it('history and attachments work with the two-argument form too', async () => {
    const { adapter, client } = setup()
    const plain = defineCallSite({
      id: 'plain',
      provider: 'p',
      model: 'm',
      userTemplate: 'Go',
    })
    const history: Message[] = [
      { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
    ]
    await client.runStructured(plain, { auth: AUTH, history })
    expect(adapter.calls[0]?.messages).toEqual([
      ...history,
      { role: 'user', parts: [{ kind: 'text', text: 'Go' }] },
    ])
  })

  it('transientProviderState reaches the adapter and never the record', async () => {
    const state = { secret: 'opaque-state-token' }
    const { adapter, sink, client } = setup(ok(), { providerState: true })
    await client.runStructured(site, VARS, { auth: AUTH, transientProviderState: state })
    expect(adapter.calls[0]?.transientProviderState).toEqual(state)
    expect(JSON.stringify(sink.records)).not.toContain('opaque-state-token')
  })

  it('transientProviderState on a model without providerState is bad_request before dispatch', async () => {
    const { adapter, sink, client } = setup(ok(), { providerState: true })
    const plain = defineCallSite({
      id: 'plain',
      provider: 'p',
      model: 'plain',
      userTemplate: 'Go',
    })
    await expect(
      client.runStructured(plain, { auth: AUTH, transientProviderState: { a: 1 } }),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(0)
  })

  it('all options together reach the adapter and the record', async () => {
    const { adapter, sink, client } = setup(ok(), { providerState: true })
    const history: Message[] = [
      { role: 'assistant', parts: [{ kind: 'text', text: 'a' }] },
    ]
    await client.runStructured(site, VARS, {
      auth: AUTH,
      externalId: 'all',
      attachments: [IMAGE],
      history,
      transientProviderState: { s: 1 },
      metadata: { tenant: 't1' },
    })
    const req = adapter.calls[0]
    expect(req?.messages).toEqual([
      ...history,
      { role: 'user', parts: [{ kind: 'text', text: 'Review this' }, IMAGE] },
    ])
    expect(req?.transientProviderState).toEqual({ s: 1 })
    expect(sink.records[0]).toMatchObject({
      externalId: 'all',
      callSiteId: 'site',
      metadata: { tenant: 't1' },
    })
  })
})

describe('runStructured empty and invalid messages', () => {
  const bare = defineCallSite({ id: 'bare', provider: 'p', model: 'm' })

  it('an empty rendered user message with no attachments is bad_request, row-less, undispatched', async () => {
    const { adapter, sink, client } = setup()
    await expect(client.runStructured(bare, { auth: AUTH })).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    await expect(
      client.runStructured(bare, { auth: AUTH, attachments: [], history: [] }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    // History alone does not make the user message non-empty.
    await expect(
      client.runStructured(bare, {
        auth: AUTH,
        history: [{ role: 'assistant', parts: [{ kind: 'text', text: 'x' }] }],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(0)
  })

  it('history is validated like generate messages', async () => {
    const { adapter, client } = setup()
    const unpaired: Message[] = [
      {
        role: 'user',
        parts: [{ kind: 'tool-result', toolCallId: 'nope', toolName: 't', result: 1 }],
      },
    ]
    await expect(
      client.runStructured(site, VARS, { auth: AUTH, history: unpaired }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      issues: [{ path: 'messages.0.parts.0.toolCallId' }],
    })
    await expect(
      client.runStructured(site, VARS, {
        auth: AUTH,
        history: [{ role: 'assistant', parts: [] }],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
  })

  it('a tool-call part is not a valid attachment (the user message cannot carry one)', async () => {
    const { adapter, client } = setup()
    await expect(
      client.runStructured(site, VARS, {
        auth: AUTH,
        attachments: [{ kind: 'tool-call', toolCallId: 'c', toolName: 't', args: {} }],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
  })

  it('a tool loop can continue through history (call, then its result)', async () => {
    const { adapter, client } = setup()
    const history: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'look it up' }] },
      {
        role: 'assistant',
        parts: [{ kind: 'tool-call', toolCallId: 'c1', toolName: 'get', args: { q: 1 } }],
      },
      {
        role: 'user',
        parts: [{ kind: 'tool-result', toolCallId: 'c1', toolName: 'get', result: 'v' }],
      },
    ]
    await client.runStructured(site, VARS, { auth: AUTH, history })
    expect(adapter.calls[0]?.messages).toHaveLength(4)
  })

  it('non-array attachments and history are bad_request', async () => {
    const { client } = setup()
    await expect(
      client.runStructured(site, VARS, {
        auth: AUTH,
        attachments: 'x' as unknown as Part[],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request', issues: [{ path: 'attachments' }] })
    await expect(
      client.runStructured(site, VARS, {
        auth: AUTH,
        history: {} as unknown as Message[],
      }),
    ).rejects.toMatchObject({ kind: 'bad_request', issues: [{ path: 'history' }] })
  })

  it('the library still does not validate output (ADR-009): a mismatching result succeeds', async () => {
    const cs = defineCallSite({
      id: 'o',
      provider: 'p',
      model: 'm',
      userTemplate: 'Go',
      jsonSchema: { type: 'object', properties: { label: { type: 'string' } } },
    })
    const { client } = setup(ok({ rawStructured: { label: 123 } }))
    const result = await client.runStructured(cs, { auth: AUTH, attachments: [PDF] })
    expect(result.output).toEqual({ label: 123 })
    expect(result.outputParsed).toBe(true)
  })
})
