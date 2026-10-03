/**
 * Opt-in payload storage (ADR-038): what is captured, what is never captured,
 * the redact-then-cap order, and that a payload problem never fails a call.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeAdapter, RecordingLogger, RecordingSink } from '@gullabs/testing'

import {
  createClient,
  createModelRegistry,
  defineCallSite,
  LlmError,
  retryMiddleware,
} from './index.js'
import type {
  AdapterResult,
  ClientConfig,
  LlmCallPayload,
  LlmRequest,
  PayloadsConfig,
  Usage,
} from './index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const USAGE: Usage = { inputTokens: 1, outputTokens: 1, details: {}, raw: null }
const AUTH = { apiKey: 'k' }
const GOOGLE_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv'

function ok(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'the answer' }] },
    text: 'the answer',
    usage: USAGE,
    model: 'm',
    warnings: [],
    ...overrides,
  }
}

function setup(
  payloads: PayloadsConfig | undefined,
  entries: Array<AdapterResult | LlmError> = [ok()],
  extra: Partial<ClientConfig> = {},
) {
  const adapter = new FakeAdapter('p', entries as AdapterResult[])
  const sink = new RecordingSink()
  const logger = new RecordingLogger()
  const client = createClient({
    adapters: [adapter],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
    ]),
    sink,
    logger,
    ...(payloads !== undefined ? { payloads } : {}),
    ...extra,
  })
  return { adapter, sink, logger, client }
}

/** A result with only the parsed structured output, as an adapter may return it. */
function structuredOnly(rawStructured: unknown): AdapterResult {
  const { text: _text, ...rest } = ok()
  void _text
  return { ...rest, rawStructured }
}

function withoutSystem(req: LlmRequest): LlmRequest {
  const { system: _system, ...rest } = req
  void _system
  return rest
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    provider: 'p',
    model: 'm',
    system: 'be brief',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

const site = defineCallSite({
  id: 'site',
  provider: 'p',
  model: 'm',
  system: 'Be brief.',
  userTemplate: 'Review {{what}}',
})

function onlyPayload(sink: RecordingSink): LlmCallPayload {
  expect(sink.payloads.size).toBe(1)
  return [...sink.payloads.values()][0] as LlmCallPayload
}

describe('payload storage is off unless the client turns it on', () => {
  it('no payloads config: no payload reaches the sink, and the sink is called with the record alone', async () => {
    const { sink, client } = setup(undefined)
    await client.generate(request(), { auth: AUTH })
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
  })

  it('storePayload: true does not turn storage on for a client that did not enable it', async () => {
    const { sink, client } = setup(undefined)
    await client.generate(request(), { auth: AUTH, storePayload: true })
    expect(sink.payloads.size).toBe(0)
  })
})

describe('what a payload holds', () => {
  it('the request the adapter received and the raw model text', async () => {
    const { sink, client } = setup({})
    await client.generate(request(), { auth: AUTH })
    expect(onlyPayload(sink)).toEqual({
      request: {
        system: 'be brief',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
      },
      response: { text: 'the answer' },
    })
  })

  it('structured output stores the raw JSON text; the parsed value is not duplicated', async () => {
    const { sink, client } = setup({}, [structuredOnly({ score: 3 })])
    await client.runStructured(
      defineCallSite({ ...site, jsonSchema: { type: 'object' } }),
      { what: 'x' },
      { auth: AUTH },
    )
    expect(onlyPayload(sink).response).toEqual({ text: '{"score":3}' })
  })

  it('media parts are a media type, a byte count and a SHA-256, never the bytes', async () => {
    const { sink, client } = setup({})
    const bytes = Buffer.from('not really a png')
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'look' },
              {
                kind: 'inline-media',
                mimeType: 'image/png',
                data: bytes.toString('base64'),
              },
              {
                kind: 'file-uri',
                uri: 'https://files.test/a.pdf',
                mimeType: 'application/pdf',
              },
              { kind: 'file-ref', fileId: 'file_1' },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(payload.request.messages[0]?.parts).toEqual([
      { kind: 'text', text: 'look' },
      {
        kind: 'inline-media',
        mimeType: 'image/png',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      { kind: 'file-uri', uri: 'https://files.test/a.pdf', mimeType: 'application/pdf' },
      { kind: 'file-ref', fileId: 'file_1' },
    ])
    expect(JSON.stringify(payload)).not.toContain(bytes.toString('base64'))
  })

  it('tool calls, tool results and tool definitions: arguments and results as JSON, tools by name and schema hash', async () => {
    const { sink, client } = setup({})
    const schema = { type: 'object', properties: { q: { type: 'string' } } }
    await client.generate(
      request({
        tools: [{ name: 'search', description: 'd', inputJsonSchema: schema }],
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'find' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c1',
                toolName: 'search',
                args: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c1',
                toolName: 'search',
                result: { hits: [1, 2] },
                isError: false,
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(payload.request.messages[1]?.parts[0]).toEqual({
      kind: 'tool-call',
      toolCallId: 'c1',
      toolName: 'search',
      args: { q: 'x' },
    })
    expect(payload.request.messages[2]?.parts[0]).toMatchObject({
      kind: 'tool-result',
      result: { hits: [1, 2] },
    })
    expect(payload.request.tools).toEqual([
      {
        name: 'search',
        // canonical JSON (sorted keys, no spaces) of the schema
        schemaSha256: createHash('sha256')
          .update('{"properties":{"q":{"type":"string"}},"type":"object"}')
          .digest('hex'),
      },
    ])
    expect(JSON.stringify(payload)).not.toContain('"description"')
  })

  it('reasoning text and model tool calls are not duplicated into the payload', async () => {
    const { sink, client } = setup({}, [
      ok({
        reasoningText: 'secret reasoning',
        toolCalls: [{ toolCallId: 'c', toolName: 't', args: { a: 1 } }],
      }),
    ])
    await client.generate(request(), { auth: AUTH })
    const json = JSON.stringify(onlyPayload(sink))
    expect(json).not.toContain('secret reasoning')
    expect(json).not.toContain('"toolCallId":"c"')
  })

  it('what the adapter received is stored: a request changed by middleware is stored changed', async () => {
    const { sink, client } = setup({}, [ok()], {
      middleware: [
        {
          id: 'rewriter',
          async intercept(req, ctx, next) {
            return next({ ...req, system: 'rewritten' }, ctx)
          },
        },
      ],
    })
    await client.generate(request(), { auth: AUTH })
    expect(onlyPayload(sink).request.system).toBe('rewritten')
  })
})

describe('one payload per dispatched attempt, errors included', () => {
  it('a failed attempt stores the error message, the retried attempt its response', async () => {
    const { sink, client } = setup(
      {},
      [new LlmError('upstream busy', { kind: 'server', retryable: true }), ok()],
      { middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })] },
    )
    await client.generate(request(), { auth: AUTH })
    expect(sink.records).toHaveLength(2)
    expect(sink.payloads.size).toBe(2)
    const [first, second] = sink.records
    expect(sink.payloads.get(first!.attemptId)?.response).toEqual({
      errorMessage: 'upstream busy',
    })
    expect(sink.payloads.get(second!.attemptId)?.response).toEqual({
      text: 'the answer',
    })
    expect(sink.payloads.get(first!.attemptId)?.request).toEqual(
      sink.payloads.get(second!.attemptId)?.request,
    )
  })

  it('a terminal failure keeps its payload, and the error still reaches the caller', async () => {
    const { sink, client } = setup({}, [
      new LlmError('bad key', { kind: 'invalid_auth', retryable: false }),
    ])
    await expect(client.generate(request(), { auth: AUTH })).rejects.toMatchObject({
      kind: 'invalid_auth',
    })
    expect(onlyPayload(sink).response).toEqual({ errorMessage: 'bad key' })
  })

  it('a refusal row (a middleware refused before dispatch) has no payload', async () => {
    const { sink, client } = setup({}, [ok()], {
      middleware: [
        {
          id: 'refuser',
          async intercept() {
            throw new LlmError('no', { kind: 'rate_limited', retryable: false })
          },
        },
      ],
    })
    await expect(client.generate(request(), { auth: AUTH })).rejects.toThrow()
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
  })
})

describe('include and storePayload: false skip on both entrypoints', () => {
  it('include returning false skips generate and runStructured', async () => {
    const seen: string[] = []
    const { sink, client } = setup(
      {
        include: (req) => {
          seen.push(req.model)
          return false
        },
      },
      [ok(), ok()],
    )
    await client.generate(request(), { auth: AUTH })
    await client.runStructured(site, { what: 'x' }, { auth: AUTH })
    expect(seen).toEqual(['m', 'm'])
    expect(sink.records).toHaveLength(2)
    expect(sink.payloads.size).toBe(0)
  })

  it('include sees the call request, so a host can select by metadata', async () => {
    const { sink, client } = setup(
      { include: (req) => req.metadata?.['keep'] === true },
      [ok(), ok()],
    )
    await client.generate(request({ metadata: { keep: true } }), { auth: AUTH })
    await client.generate(request({ metadata: { keep: false } }), { auth: AUTH })
    expect(sink.records).toHaveLength(2)
    expect(sink.payloads.size).toBe(1)
    expect(sink.payloads.has(sink.records[0]!.attemptId)).toBe(true)
  })

  it('only exactly true captures: an include that returns nothing skips', async () => {
    const { sink, client } = setup({
      include: (() => undefined) as unknown as () => boolean,
    })
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(0)
  })

  it('a throwing include skips the payload, warns, and does not fail the call', async () => {
    const { sink, logger, client } = setup({
      include: () => {
        throw new Error('include blew up')
      },
    })
    await expect(client.generate(request(), { auth: AUTH })).resolves.toMatchObject({
      text: 'the answer',
    })
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')?.level).toBe('warn')
  })

  it('storePayload: false skips generate', async () => {
    const { sink, client } = setup({})
    await client.generate(request(), { auth: AUTH, storePayload: false })
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
  })

  it('storePayload: false skips runStructured (both overloads)', async () => {
    const { sink, client } = setup({}, [ok(), ok()])
    await client.runStructured(site, { what: 'x' }, { auth: AUTH, storePayload: false })
    await client.runStructured(
      defineCallSite({ id: 's2', provider: 'p', model: 'm', userTemplate: 'fixed' }),
      { auth: AUTH, storePayload: false },
    )
    expect(sink.records).toHaveLength(2)
    expect(sink.payloads.size).toBe(0)
  })

  it('runStructured stores a payload by default when the client is on, with the rendered request', async () => {
    const { sink, client } = setup({})
    await client.runStructured(site, { what: 'the thing' }, { auth: AUTH })
    expect(onlyPayload(sink).request).toEqual({
      system: 'Be brief.',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Review the thing' }] }],
    })
  })

  it('storePayload is a boolean: anything else is bad_request before dispatch', async () => {
    const { adapter, client } = setup({})
    await expect(
      client.generate(request(), {
        auth: AUTH,
        storePayload: 'no' as unknown as boolean,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(
      client.runStructured(
        site,
        { what: 'x' },
        { auth: AUTH, storePayload: 0 as unknown as boolean },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
  })
})

describe('redaction runs on every string, then the host redactor, then the caps', () => {
  it('core patterns redact secrets nested in tool-call arguments and tool-result values', async () => {
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: `use key=${GOOGLE_KEY} ok` }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c1',
                toolName: 't',
                args: {
                  headers: [{ auth: 'Bearer abc.def.ghi' }],
                  url: `https://x.test?api_key=${GOOGLE_KEY}`,
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c1',
                toolName: 't',
                result: { deep: { list: [`token=sekret123`, GOOGLE_KEY] } },
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const json = JSON.stringify(onlyPayload(sink))
    expect(json).not.toContain(GOOGLE_KEY)
    expect(json).not.toContain('abc.def.ghi')
    expect(json).not.toContain('sekret123')
    expect(json).toContain('AIza…REDACTED')
    expect(json).toContain('Bearer …REDACTED')
  })

  it('the response text and the error message are redacted too', async () => {
    const { sink, client } = setup({}, [
      new LlmError(`failed for ${GOOGLE_KEY}`, { kind: 'server', retryable: false }),
    ])
    await expect(client.generate(request(), { auth: AUTH })).rejects.toThrow()
    expect(JSON.stringify(onlyPayload(sink))).not.toContain(GOOGLE_KEY)
  })

  it('the host redactor runs after core redaction and may change the payload', async () => {
    const seen: string[] = []
    const { sink, client } = setup({
      redact: (payload) => {
        seen.push(JSON.stringify(payload))
        return {
          ...payload,
          response: { text: (payload.response.text ?? '').replace('answer', '[host]') },
        }
      },
    })
    await client.generate(
      request({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: `k=${GOOGLE_KEY}` }] }],
      }),
      { auth: AUTH },
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain(GOOGLE_KEY)
    expect(onlyPayload(sink).response.text).toBe('the [host]')
  })

  it('the host redactor receives a copy: changing it in place does not touch the request', async () => {
    const messages = [
      { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hello' }] },
    ]
    const { sink, client } = setup({
      redact: (payload) => {
        const part = payload.request.messages[0]?.parts[0]
        if (part?.kind === 'text') part.text = 'mutated'
        return payload
      },
    })
    await client.generate(request({ messages }), { auth: AUTH })
    expect(messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'hello' })
    expect(JSON.stringify(onlyPayload(sink))).toContain('mutated')
  })

  it('a host redactor that enlarges text is still capped, because the cap is applied last', async () => {
    const { sink, client } = setup({
      maxChars: 100,
      redact: (payload) => ({
        ...payload,
        response: { text: `${payload.response.text ?? ''}${'x'.repeat(5000)}` },
      }),
    })
    await client.generate(request(), { auth: AUTH })
    const text = onlyPayload(sink).response.text ?? ''
    expect(text.length).toBe(100 + '[truncated]'.length)
    expect(text.endsWith('[truncated]')).toBe(true)
  })

  it('every string leaf over maxChars is cut, nested ones included; shorter ones are untouched', async () => {
    const { sink, client } = setup({ maxChars: 200 })
    await client.generate(
      request({
        system: 'y'.repeat(300),
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'short' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c',
                toolName: 't',
                args: { big: 'z'.repeat(300) },
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(payload.request.system).toBe(`${'y'.repeat(200)}[truncated]`)
    expect(payload.request.messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'short' })
    expect(payload.request.messages[1]?.parts[0]).toMatchObject({
      args: { big: `${'z'.repeat(200)}[truncated]` },
    })
  })

  it('the whole payload is capped at 4 x maxChars: the largest strings become a marker first', async () => {
    const maxChars = 1000
    const { sink, client } = setup({ maxChars })
    // 990 + 980 + 970 + 960 + 100 characters of text plus the structure is over
    // 4000; dropping only the largest string brings it back under.
    const lengths = [990, 980, 970, 960, 100]
    const messages = lengths.map((n, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      parts: [{ kind: 'text' as const, text: `${i}`.repeat(n) }],
    }))
    await client.generate(withoutSystem(request({ messages })), { auth: AUTH })
    const payload = onlyPayload(sink)
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(4 * maxChars)
    const texts = payload.request.messages.map(
      (m) => (m.parts[0] as { text: string }).text,
    )
    expect(texts[0]).toBe('[dropped: over the payload size cap]')
    expect(texts.slice(1)).toEqual(lengths.slice(1).map((n, i) => `${i + 1}`.repeat(n)))
  })

  it('a payload that cannot get under the cap even with every large string dropped is dropped with a warning', async () => {
    const { sink, logger, client } = setup({ maxChars: 1 })
    await expect(client.generate(request(), { auth: AUTH })).resolves.toBeDefined()
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')?.level).toBe('warn')
  })

  it('U+0000 and unpaired surrogates are cleaned, so the payload is Postgres-safe', async () => {
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'a\u0000b\ud800c' }] }],
      }),
      { auth: AUTH },
    )
    expect(onlyPayload(sink).request.messages[0]?.parts[0]).toEqual({
      kind: 'text',
      text: 'ab�c',
    })
  })
})

describe('a payload problem never fails a call', () => {
  it('a throwing redactor drops the payload with a warning; the call and its ledger row are unaffected', async () => {
    const { sink, logger, client } = setup({
      redact: () => {
        throw new Error('redactor failed on customer text')
      },
    })
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.text).toBe('the answer')
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    const warning = logger.find('llm.call.payload.dropped')
    expect(warning?.level).toBe('warn')
    expect(warning?.fields).toMatchObject({
      callId: result.callId,
      attemptId: result.attemptId,
    })
  })

  it('a redactor that returns something that is not a payload drops it', async () => {
    const { sink, logger, client } = setup({
      redact: (() => 'nope') as unknown as PayloadsConfig['redact'] & object,
    })
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')).toBeDefined()
  })

  it('an async redactor is refused rather than storing a Promise', async () => {
    const { sink, logger, client } = setup({
      redact: ((p: LlmCallPayload) =>
        Promise.resolve(p)) as unknown as PayloadsConfig['redact'] & object,
    })
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')).toBeDefined()
  })

  it('a failed attempt whose payload cannot be built still throws the attempt error unchanged', async () => {
    const { sink, client } = setup(
      {
        redact: () => {
          throw new Error('boom')
        },
      },
      [new LlmError('provider down', { kind: 'server', retryable: false })],
    )
    await expect(client.generate(request(), { auth: AUTH })).rejects.toMatchObject({
      kind: 'server',
      message: 'provider down',
    })
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
  })

  it('a media part that is not valid base64 drops the payload with a warning', async () => {
    const { sink, logger, client } = setup({})
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'inline-media', mimeType: 'image/png', data: '***not base64***' },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')).toBeDefined()
  })

  it('the warning does not carry more than a bounded slice of the error text', async () => {
    const { logger, client } = setup({
      redact: () => {
        throw new Error('z'.repeat(5000))
      },
    })
    await client.generate(request(), { auth: AUTH })
    const error = (
      logger.find('llm.call.payload.dropped')?.fields as Record<string, unknown>
    )['error']
    expect(String(error).length).toBeLessThanOrEqual(300)
  })
})

describe('createClient rejects an unusable payloads config', () => {
  const base = {
    adapters: [new FakeAdapter('p', [ok()])],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
    ]),
  }

  it('payloads without a sink is bad_request: there is nowhere to hand the payload', () => {
    expect(() => createClient({ ...base, payloads: {} })).toThrow(
      expect.objectContaining({ kind: 'bad_request' }) as Error,
    )
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10'])(
    'maxChars %s is bad_request',
    (maxChars) => {
      expect(() =>
        createClient({
          ...base,
          sink: new RecordingSink(),
          payloads: { maxChars: maxChars as number },
        }),
      ).toThrow(expect.objectContaining({ kind: 'bad_request' }) as Error)
    },
  )

  it('an unknown option and a non-function redact or include are bad_request', () => {
    for (const payloads of [
      { storeBytes: true },
      { redact: 'x' },
      { include: true },
    ] as unknown as PayloadsConfig[]) {
      expect(() =>
        createClient({ ...base, sink: new RecordingSink(), payloads }),
      ).toThrow(expect.objectContaining({ kind: 'bad_request' }) as Error)
    }
  })

  it('an empty config is valid and means on, with the defaults', async () => {
    const sink = new RecordingSink()
    const client = createClient({ ...base, sink, payloads: {} })
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(1)
  })
})
