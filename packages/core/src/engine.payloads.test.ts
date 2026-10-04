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
import { PAYLOAD_MAX_INLINE_MEDIA_BYTES } from './payload.js'
import type {
  AdapterResult,
  ClientConfig,
  LlmCallPayload,
  LlmRequest,
  PayloadsConfig,
  Scheduler,
  TimerHandle,
  Usage,
} from './index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const USAGE: Usage = { inputTokens: 1, outputTokens: 1, details: {}, raw: null }
const AUTH = { apiKey: 'k' }
// Synthetic credentials are assembled from fragments so secret scanners do not flag the fixtures.
const GOOGLE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')

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
      maxChars: 1000,
      redact: (payload) => ({
        ...payload,
        response: { text: `${payload.response.text ?? ''}${'x'.repeat(5000)}` },
      }),
    })
    await client.generate(request(), { auth: AUTH })
    const text = onlyPayload(sink).response.text ?? ''
    expect(text.length).toBe(1000 + '[truncated]'.length)
    expect(text.endsWith('[truncated]')).toBe(true)
  })

  it('every string leaf over maxChars is cut, nested ones included; shorter ones are untouched', async () => {
    const { sink, client } = setup({ maxChars: 1000 })
    await client.generate(
      request({
        system: 'y'.repeat(1500),
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'short' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c',
                toolName: 't',
                args: { big: 'z'.repeat(1500) },
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(payload.request.system).toBe(`${'y'.repeat(1000)}[truncated]`)
    expect(payload.request.messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'short' })
    expect(payload.request.messages[1]?.parts[0]).toMatchObject({
      args: { big: `${'z'.repeat(1000)}[truncated]` },
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

  it('candidates are ordered by serialized space saved: escaped strings are replaced ahead of longer plain ones, and a plain short one is never a stopper', async () => {
    const maxChars = 1000
    const { sink, client } = setup({ maxChars })
    // 20 plain 30-character texts, then 20 texts of 20 control characters (each
    // serializes as a 6-character escape). The payload is over 4000 and only the
    // escaped texts save enough when replaced; the plain ones save nothing.
    const plain = Array.from({ length: 20 }, () => ({
      kind: 'text' as const,
      text: 'p'.repeat(30),
    }))
    const escaped = Array.from({ length: 20 }, () => ({
      kind: 'text' as const,
      text: '\u0001'.repeat(20),
    }))
    await client.generate(
      withoutSystem(
        request({
          messages: [{ role: 'user', parts: [...plain, ...escaped] }],
        }),
      ),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(4 * maxChars)
    const texts = (payload.request.messages[0]?.parts as Array<{ text: string }>).map(
      (part) => part.text,
    )
    expect(texts.slice(0, 20)).toEqual(plain.map((part) => part.text))
    const marker = '[dropped: over the payload size cap]'
    expect(texts.slice(20).some((t) => t === marker)).toBe(true)
    expect(texts.slice(20).every((t) => t === marker || t === escaped[0]?.text)).toBe(
      true,
    )
  })

  it('a payload that cannot get under the cap even with every large string dropped is dropped with a warning', async () => {
    const { sink, logger, client } = setup({ maxChars: 1000 })
    // 100 tools: each entry is a name and a 64-character hash, which no marker shrinks
    const tools = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'd',
      inputJsonSchema: { type: 'object' },
    }))
    await expect(
      client.generate(request({ tools }), { auth: AUTH }),
    ).resolves.toBeDefined()
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

  it('the warning carries the stage, a fixed category, the thrown type and a fixed sentence, never the error text or name', async () => {
    const { logger, client } = setup({
      redact: () => {
        const error = new TypeError('patient SSN 123-45-6789 in the redactor error')
        error.name = 'Customer 987-65-4321'
        throw error
      },
    })
    await client.generate(request(), { auth: AUTH })
    const entry = logger.find('llm.call.payload.dropped')
    expect(entry?.fields).toEqual({
      callId: expect.any(String),
      attemptId: expect.any(String),
      stage: 'redact',
      category: 'redactor_threw',
      thrownType: 'error',
      error: 'the redact function threw',
    })
    expect(JSON.stringify(logger.entries)).not.toContain('123-45-6789')
    expect(JSON.stringify(logger.entries)).not.toContain('987-65-4321')
  })

  it('a throwing include logs the fixed include_threw category', async () => {
    const { logger, client } = setup({
      include: () => {
        throw 'plain string with customer text'
      },
    })
    await client.generate(request(), { auth: AUTH })
    const entry = logger.find('llm.call.payload.dropped')
    expect(entry?.fields).toMatchObject({
      stage: 'include',
      category: 'include_threw',
      thrownType: 'non_error',
    })
    expect(JSON.stringify(logger.entries)).not.toContain('customer text')
  })

  describe('a hostile error from the redactor cannot lose the ledger row', () => {
    function hostileGetters(): Error {
      const error = new Error('x')
      for (const key of ['name', 'message', 'stack']) {
        Object.defineProperty(error, key, {
          get() {
            throw error
          },
        })
      }
      return error
    }
    const hostileProxy = (): Error =>
      new Proxy(new Error('x'), {
        get() {
          throw new Error('proxy get trap')
        },
        getPrototypeOf() {
          throw new Error('proxy getPrototypeOf trap')
        },
      })

    for (const [label, make] of [
      ['name, message and stack getters that rethrow', hostileGetters],
      ['a Proxy that throws on every property read and prototype read', hostileProxy],
    ] as const) {
      it(`${label}: the call succeeds and the billed row is written`, async () => {
        const { sink, logger, client } = setup({
          redact: () => {
            throw make()
          },
        })
        const result = await client.generate(request(), { auth: AUTH })
        expect(result.text).toBe('the answer')
        expect(sink.records).toHaveLength(1)
        expect(sink.records[0]?.attemptId).toBe(result.attemptId)
        expect(sink.payloads.size).toBe(0)
        const entry = logger.find('llm.call.payload.dropped')
        expect(entry?.fields).toMatchObject({
          stage: 'redact',
          category: 'redactor_threw',
        })
        expect(logger.find('llm.call.sink.failed')).toBeUndefined()
      })
    }

    it('a throwing logger.warn cannot stop the ledger write either', async () => {
      const { sink, logger, client } = setup({
        redact: () => {
          throw new Error('boom')
        },
      })
      const original = logger.warn.bind(logger)
      logger.warn = (fields, message) => {
        if (message === 'llm.call.payload.dropped') throw new Error('logger down')
        original(fields, message)
      }
      const result = await client.generate(request(), { auth: AUTH })
      expect(result.text).toBe('the answer')
      expect(sink.records).toHaveLength(1)
    })
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

  it.each([0, -1, 1.5, 999, 1, Number.NaN, Number.POSITIVE_INFINITY, '10000'])(
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

// ---------------------------------------------------------------------------
// Payload building, redaction and inline media
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/**
 * A scheduler that counts zero-delay yields. `fireImmediately` makes the timer
 * with that delay fire at once; `fireOnFirstYield` holds it back and fires it
 * when the first zero-delay yield happens, so it ends mid-build.
 */
function spyScheduler(
  opts: { fireImmediately?: number; fireOnFirstYield?: number } = {},
) {
  const counts = { yields: 0 }
  let held: (() => void) | undefined
  const scheduler: Scheduler = {
    setTimeout: (callback, ms) => {
      if (ms === 0) {
        counts.yields += 1
        if (held !== undefined) {
          const fire = held
          held = undefined
          fire()
        }
      }
      if (ms === opts.fireImmediately) {
        queueMicrotask(callback)
        return 0 as unknown as TimerHandle
      }
      if (ms === opts.fireOnFirstYield) {
        held = callback
        return 0 as unknown as TimerHandle
      }
      return realSetTimeout(callback, ms)
    },
    clearTimeout: (handle) => {
      realClearTimeout(handle as ReturnType<typeof realSetTimeout>)
    },
  }
  return { scheduler, counts }
}

/** Twelve 300 KB messages: with the default cap each is bounded to 200 KB, so about 12M units of work. */
function bigConversation(): LlmRequest['messages'] {
  return Array.from({ length: 12 }, (_, i) => ({
    role: 'user' as const,
    parts: [{ kind: 'text' as const, text: `${i % 10}`.repeat(300_000) }],
  }))
}

function textMessage(text: string): LlmRequest['messages'] {
  return [{ role: 'user', parts: [{ kind: 'text', text }] }]
}

describe('building a payload is linear and inside the sink budget', () => {
  it('280 KB of X-Goog- and 1 MB of A in one prompt build in well under a second', async () => {
    const { sink, client } = setup({})
    const hostile = `${'X-Goog-'.repeat(40_000)}${'A'.repeat(1_000_000)}`
    const start = performance.now()
    await client.generate(request({ messages: textMessage(hostile) }), { auth: AUTH })
    expect(performance.now() - start).toBeLessThan(1500)
    const stored = onlyPayload(sink).request.messages[0]?.parts[0] as { text: string }
    expect(stored.text.length).toBe(200_000 + '[truncated]'.length)
  })

  it('a hostile model reply is bounded the same way', async () => {
    const reply = 'X-Goog-'.repeat(40_000)
    const { sink, client } = setup({}, [ok({ text: reply })])
    const start = performance.now()
    await client.generate(request(), { auth: AUTH })
    expect(performance.now() - start).toBeLessThan(1500)
    expect((onlyPayload(sink).response.text ?? '').endsWith('[truncated]')).toBe(true)
  })

  it('the build runs inside the sink budget: when the wait ends first the payload is dropped and the ledger row is still written', async () => {
    const { scheduler } = spyScheduler({ fireImmediately: 7777 })
    const { sink, logger, client } = setup({}, [ok()], { scheduler, sinkTimeoutMs: 7777 })
    await client.generate(request({ messages: bigConversation() }), { auth: AUTH })
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')?.fields).toMatchObject({
      stage: 'timeout',
    })
    expect(logger.find('llm.call.sink.timeout')).toBeDefined()
  })

  it('a wait that ends mid-build stops the build at its next step instead of finishing it', async () => {
    const { scheduler, counts } = spyScheduler({ fireOnFirstYield: 7777 })
    const { sink, logger, client } = setup({}, [ok()], { scheduler, sinkTimeoutMs: 7777 })
    await client.generate(request({ messages: bigConversation() }), { auth: AUTH })
    expect(counts.yields).toBe(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.sink.timeout')).toBeDefined()
  })

  it('a build that yields lets the event loop run: a large payload takes more than one turn', async () => {
    const { scheduler, counts } = spyScheduler()
    const { sink, client } = setup({}, [ok()], { scheduler })
    await client.generate(request({ messages: bigConversation() }), { auth: AUTH })
    expect(sink.payloads.size).toBe(1)
    expect(counts.yields).toBeGreaterThan(1)
  })

  it('a small payload never touches the scheduler', async () => {
    const { scheduler, counts } = spyScheduler()
    const { sink, client } = setup({}, [ok()], { scheduler })
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(1)
    expect(counts.yields).toBe(0)
  })

  it.each([
    ['a Google key', GOOGLE_KEY, 'SyA12345'],
    ['a bearer token', `Bearer ${'abcdef'.repeat(10)}`, 'abcdef'],
    ['a signed URL parameter', `X-Amz-Signature=${'f0'.repeat(30)}`, 'f0f0f0'],
    ['an sk- key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'AbCdEfGh'],
  ])(
    '%s cut by the pre-redaction window does not survive as a fragment',
    async (_n, secret, fragment) => {
      const maxChars = 1000
      const window = maxChars + 256
      for (let offset = 1; offset <= secret.length + 4; offset += 1) {
        // 20 keys up front shrink by 520 characters in redaction, so text from the
        // edge of the window ends up inside maxChars if it is not dropped
        const lead = `${`${GOOGLE_KEY} `.repeat(20)}`
        const text = `${lead}${'x'.repeat(window - lead.length - offset - 1)} ${secret} tail`
        const { sink, client } = setup({ maxChars })
        await client.generate(request({ messages: textMessage(text) }), { auth: AUTH })
        const stored = (
          onlyPayload(sink).request.messages[0]?.parts[0] as { text: string }
        ).text
        expect(stored.endsWith('[truncated]')).toBe(true)
        expect(stored.length).toBeLessThan(maxChars)
        // no part of the secret's value survives
        expect(stored, `offset ${offset}`).not.toContain(fragment)
        expect(stored, `offset ${offset}`).not.toMatch(/AIza(?!…)/)
      }
    },
  )

  it('a string longer than the window is stored with the marker, even when redaction shrinks it below maxChars', async () => {
    const maxChars = 1000
    // 200 keys, each 39 characters becoming 13 after redaction
    const text = `${`${GOOGLE_KEY} `.repeat(200)}${'y'.repeat(2000)}`
    const { sink, client } = setup({ maxChars })
    await client.generate(request({ messages: textMessage(text) }), { auth: AUTH })
    const stored = (onlyPayload(sink).request.messages[0]?.parts[0] as { text: string })
      .text
    expect(stored.endsWith('[truncated]')).toBe(true)
    expect(stored).not.toContain('SyA1234567890')
    expect(stored.split('[truncated]').length).toBe(2)
  })
})

describe('what the llm_calls record holds, with and without a payload', () => {
  const toolCalls = [
    {
      toolCallId: 'c1',
      toolName: 'http',
      args: { body: 'PATIENT SSN 123-45-6789', h: 'Bearer abcdef123456', password: 'p' },
    },
  ]

  it('tool-call arguments and reasoning text are redacted on the record, whatever the payload settings', async () => {
    for (const payloads of [undefined, {}, { include: () => false }]) {
      const { sink, client } = setup(payloads, [
        ok({ toolCalls, reasoningText: `reasoning with ${GOOGLE_KEY}` }),
      ])
      await client.generate(request(), { auth: AUTH, storePayload: false })
      const record = sink.records[0]
      expect(JSON.stringify(record)).not.toContain(GOOGLE_KEY)
      expect(JSON.stringify(record)).not.toContain('abcdef123456')
      expect(record?.toolCalls).toEqual([
        {
          toolCallId: 'c1',
          toolName: 'http',
          args: {
            body: 'PATIENT SSN 123-45-6789',
            h: 'Bearer …REDACTED',
            password: '[REDACTED]',
          },
        },
      ])
      expect(record?.reasoningText).toBe('reasoning with AIza…REDACTED')
      expect(sink.payloads.size).toBe(0)
    }
  })

  it('storePayload: false governs only the payload: customer text the model produced stays on the record', async () => {
    const { sink, client } = setup({}, [
      ok({ reasoningText: 'the customer SSN 123-45-6789 was mentioned', toolCalls }),
    ])
    await client.generate(request(), { auth: AUTH, storePayload: false })
    expect(sink.records[0]?.reasoningText).toContain('123-45-6789')
    expect(JSON.stringify(sink.records[0]?.toolCalls)).toContain('123-45-6789')
    expect(sink.payloads.size).toBe(0)
  })
})

describe('signed URLs, headers, provider keys and secret-named keys', () => {
  it('a file-uri keeps scheme, host and path only: no query, fragment or userinfo', async () => {
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'file-uri',
                uri: `https://user:pw@b.s3.amazonaws.com/path/a.pdf?X-Amz-Credential=${AWS_KEY}&X-Amz-Signature=deadbeef#frag`,
                mimeType: 'application/pdf',
              },
              { kind: 'file-uri', uri: 'gs://bucket/obj.png', mimeType: 'image/png' },
              {
                kind: 'file-uri',
                uri: 'data:text/plain;base64,c2VjcmV0',
                mimeType: 'text/plain',
              },
              { kind: 'file-uri', uri: 'not a url?sig=abc', mimeType: 'text/plain' },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    expect(onlyPayload(sink).request.messages[0]?.parts).toEqual([
      {
        kind: 'file-uri',
        uri: 'https://b.s3.amazonaws.com/path/a.pdf',
        mimeType: 'application/pdf',
      },
      { kind: 'file-uri', uri: 'gs://bucket/obj.png', mimeType: 'image/png' },
      { kind: 'file-uri', uri: 'data:[stripped]', mimeType: 'text/plain' },
      { kind: 'file-uri', uri: 'not a url', mimeType: 'text/plain' },
    ])
  })

  it('text patterns: lowercase bearer, Authorization: Basic, sk-, ghp_, xai-, ya29., presigned and SAS parameters', async () => {
    const secrets = [
      'abcdef0123456789bearer',
      'dXNlcjpwYXNzd29yZA',
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xai-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      'ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz',
      'deadbeefsignature',
      'SASsignatureValue',
      'tok3nvalue',
      AWS_KEY,
    ]
    const text = [
      'authorization: bearer abcdef0123456789bearer',
      'Authorization: Basic dXNlcjpwYXNzd29yZA',
      'k sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'g ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'x xai-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      'o ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz',
      `https://b.s3.amazonaws.com/o?X-Amz-Signature=deadbeefsignature&X-Amz-Credential=${AWS_KEY}%2F2026`,
      'https://a.blob.core.windows.net/c?sig=SASsignatureValue',
      'Token=tok3nvalue',
    ].join('\n')
    const { sink, client } = setup({})
    await client.generate(request({ system: text, messages: textMessage(text) }), {
      auth: AUTH,
    })
    const json = JSON.stringify(onlyPayload(sink))
    for (const secret of secrets) expect(json, secret).not.toContain(secret)
  })

  it('tool arguments and results: the value of a secret-named key is replaced; a secret used as a key name is redacted', async () => {
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c',
                toolName: 't',
                args: {
                  password: 'hunter2',
                  nested: { API_KEY: 'sk-live-123', list: [{ Authorization: 'x' }] },
                  'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789': 1,
                  keep: 'visible',
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c',
                toolName: 't',
                result: {
                  token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                  url: 'https://x.test?X-Amz-Signature=abc',
                  client_secret: { a: 1 },
                },
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const messages = onlyPayload(sink).request.messages
    expect(messages[0]?.parts[0]).toMatchObject({
      args: {
        password: '[REDACTED]',
        nested: { API_KEY: '[REDACTED]', list: [{ Authorization: '[REDACTED]' }] },
        'sk-…REDACTED': 1,
        keep: 'visible',
      },
    })
    expect(messages[1]?.parts[0]).toMatchObject({
      result: {
        token: '[REDACTED]',
        url: 'https://x.test?X-Amz-Signature=REDACTED',
        client_secret: '[REDACTED]',
      },
    })
    expect(JSON.stringify(messages)).not.toContain('hunter2')
  })
})

describe('U+0000 is stripped before redaction, so a split secret is redacted whole', () => {
  it('in text, system, tool arguments, results and the response', async () => {
    const split = `AIza\u0000SyA1234567890abcdefghijklmnopqrstuv`
    const bearer = `Bearer \u0000abcdef1234567890SECRET`
    const { sink, client } = setup({}, [ok({ text: `reply ${split}` })])
    await client.generate(
      request({
        system: `sys ${split}`,
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: `${split} ${bearer}` }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c',
                toolName: 't',
                args: { note: split },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c',
                toolName: 't',
                result: [bearer],
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const json = JSON.stringify(onlyPayload(sink))
    expect(json).not.toContain('SyA1234567890')
    expect(json).not.toContain('abcdef1234567890SECRET')
    expect(json).not.toContain('\\u0000')
    expect(json).toContain('AIza…REDACTED')
  })

  it('U+0000 a host redactor adds is stripped too', async () => {
    const { sink, client } = setup({
      redact: (payload) => ({ ...payload, response: { text: 'a\u0000b' } }),
    })
    await client.generate(request(), { auth: AUTH })
    expect(onlyPayload(sink).response.text).toBe('ab')
  })
})

describe('inline media is hashed in chunks, with limits', () => {
  it('a multi-megabyte part hashes to the right digest and yields to the event loop', async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 5, 7)
    const { scheduler, counts } = spyScheduler()
    const { sink, client } = setup({}, [ok()], { scheduler })
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'inline-media',
                mimeType: 'video/mp4',
                data: bytes.toString('base64'),
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    expect(onlyPayload(sink).request.messages[0]?.parts[0]).toEqual({
      kind: 'inline-media',
      mimeType: 'video/mp4',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(counts.yields).toBeGreaterThan(0)
  })

  it('yields to the event loop at least every 2 MiB of base64, so no stretch stalls it long', async () => {
    // 8 MiB decoded is 11,184,812 base64 characters: five full 2 MiB stretches (and a
    // 0.7 MiB remainder), so at least five yields. The hash runs at about 7 ms per MiB
    // of decoded bytes (measured, Node 24), so a 2 MiB-of-base64 stretch is about 10 ms.
    const bytes = Buffer.alloc(8 * 1024 * 1024, 3)
    const data = bytes.toString('base64')
    expect(data.length).toBe(11_184_812)
    const { scheduler, counts } = spyScheduler()
    const { sink, client } = setup({}, [ok()], { scheduler })
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'video/mp4', data }],
          },
        ],
      }),
      { auth: AUTH },
    )
    expect(onlyPayload(sink).request.messages[0]?.parts[0]).toMatchObject({
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(counts.yields).toBeGreaterThanOrEqual(Math.floor(data.length / 2_097_152))
    // ... and not a yield per chunk: the cadence is the constant, not "as often as possible".
    expect(counts.yields).toBeLessThanOrEqual(Math.ceil(data.length / 2_097_152))
  })

  it('unpadded base64 and every padding length are hashed correctly', async () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000, 1001]) {
      const bytes = Buffer.alloc(length, 9)
      const { sink, client } = setup({})
      await client.generate(
        request({
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'inline-media',
                  mimeType: 'a/b',
                  data: bytes.toString('base64').replace(/=+$/, ''),
                },
              ],
            },
          ],
        }),
        { auth: AUTH },
      )
      expect(onlyPayload(sink).request.messages[0]?.parts[0]).toMatchObject({
        bytes: length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  })

  it('a part over the per-part limit is stored as too_large, unhashed, and the payload keeps everything else', async () => {
    const data = 'A'.repeat(
      Math.ceil(((PAYLOAD_MAX_INLINE_MEDIA_BYTES + 3) * 4) / 3 / 4) * 4,
    )
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'look' },
              { kind: 'inline-media', mimeType: 'video/mp4', data },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const parts = onlyPayload(sink).request.messages[0]?.parts
    expect(parts?.[0]).toEqual({ kind: 'text', text: 'look' })
    expect(parts?.[1]).toEqual({
      kind: 'inline-media',
      mimeType: 'video/mp4',
      bytes: (data.length * 3) / 4,
      sha256: null,
      skipped: 'too_large',
    })
  })

  it.each([
    ['not base64 at all', '***not base64***'],
    ['base64url', 'ab-_cd'],
    ['a stray equals sign', 'ab=cdefg'],
    ['an impossible length', 'abcde'],
  ])(
    '%s drops only that part, as invalid_base64; the payload and the other parts stay',
    async (_name, data) => {
      const { sink, logger, client } = setup({})
      await client.generate(
        request({
          messages: [
            {
              role: 'user',
              parts: [
                { kind: 'inline-media', mimeType: 'image/png', data },
                { kind: 'text', text: 'still here' },
              ],
            },
          ],
        }),
        { auth: AUTH },
      )
      expect(onlyPayload(sink).request.messages[0]?.parts).toEqual([
        {
          kind: 'inline-media',
          mimeType: 'image/png',
          bytes: null,
          sha256: null,
          skipped: 'invalid_base64',
        },
        { kind: 'text', text: 'still here' },
      ])
      expect(logger.find('llm.call.payload.dropped')).toBeUndefined()
    },
  )

  it('a failed attempt with a bad media part still stores its error message', async () => {
    const { sink, client } = setup({}, [
      new LlmError('provider down', { kind: 'server', retryable: false }),
    ])
    await expect(
      client.generate(
        request({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'inline-media', mimeType: 'a/b', data: '***' }],
            },
          ],
        }),
        { auth: AUTH },
      ),
    ).rejects.toThrow()
    expect(onlyPayload(sink).response).toEqual({ errorMessage: 'provider down' })
  })
})

describe('P3: key handling, snapshot, sizes, config', () => {
  it('a __proto__ key in tool arguments and results is data, not a prototype', async () => {
    const args = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>
    const result = JSON.parse('{"__proto__":["y"],"b":2}') as Record<string, unknown>
    const { sink, client } = setup({})
    await client.generate(
      request({
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'c',
                toolName: 't',
                args: args as never,
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c',
                toolName: 't',
                result: result as never,
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const [call, res] = onlyPayload(sink).request.messages.map((m) => m.parts[0])
    expect(JSON.stringify((call as { args: unknown }).args)).toBe(
      '{"__proto__":{"x":1},"a":1}',
    )
    expect(JSON.stringify((res as { result: unknown }).result)).toBe(
      '{"__proto__":["y"],"b":2}',
    )
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('the payload is the request as dispatched: a host that changes it mid-call changes nothing stored', async () => {
    const messages: LlmRequest['messages'] = [
      { role: 'user', parts: [{ kind: 'text', text: 'go' }] },
      {
        role: 'assistant',
        parts: [{ kind: 'tool-call', toolCallId: 'c', toolName: 't', args: {} }],
      },
      {
        role: 'user',
        parts: [
          { kind: 'text', text: 'sent-text' },
          { kind: 'tool-result', toolCallId: 'c', toolName: 't', result: { a: 1 } },
        ],
      },
    ]
    const adapter = new (class extends FakeAdapter {
      override async run(
        ...args: Parameters<FakeAdapter['run']>
      ): ReturnType<FakeAdapter['run']> {
        const first = messages[2]
        if (first !== undefined) {
          ;(first.parts[0] as { text: string }).text = 'HOST-CHANGED-LATER'
          first.parts.push({ kind: 'text', text: 'HOST-APPENDED-LATER' })
          ;(first.parts[1] as unknown as { result: { a: number } }).result.a = 99
        }
        return super.run(...args)
      }
    })('p', [ok()])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
      ]),
      sink,
      payloads: {},
    })
    await client.generate(request({ messages }), { auth: AUTH })
    expect(adapter.calls).toHaveLength(1)
    const stored = JSON.stringify(onlyPayload(sink))
    expect(stored).toContain('sent-text')
    expect(stored).not.toContain('HOST-CHANGED-LATER')
    expect(stored).not.toContain('HOST-APPENDED-LATER')
    expect(stored).toContain('"result":{"a":1}')
  })

  it('a large numeric array in a tool result is dropped alone; the payload is kept', async () => {
    const { sink, client } = setup({ maxChars: 1000 })
    await client.generate(
      request({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'embed' }] },
          {
            role: 'assistant',
            parts: [{ kind: 'tool-call', toolCallId: 'c', toolName: 'embed', args: {} }],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c',
                toolName: 'embed',
                result: { embedding: Array.from({ length: 5000 }, () => 0.123456789) },
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const payload = onlyPayload(sink)
    expect(payload.request.messages[0]?.parts[0]).toEqual({ kind: 'text', text: 'embed' })
    expect(payload.request.messages[2]?.parts[0]).toMatchObject({
      kind: 'tool-result',
      result: '[dropped: over the payload size cap]',
    })
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(4000)
  })

  it('maxChars changed after createClient does not bypass validation', async () => {
    const config = { maxChars: 1000 }
    const { sink, client } = setup(config)
    config.maxChars = 5
    await client.generate(request(), { auth: AUTH })
    expect(sink.payloads.size).toBe(1)
  })

  it('an async include or redact function is bad_request at createClient', () => {
    const base = {
      adapters: [new FakeAdapter('p', [ok()])],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
      ]),
      sink: new RecordingSink(),
    }
    expect(() =>
      createClient({
        ...base,
        payloads: { include: (async () => true) as unknown as () => boolean },
      }),
    ).toThrow(expect.objectContaining({ kind: 'bad_request' }) as Error)
    expect(() =>
      createClient({
        ...base,
        payloads: { redact: (async (p: LlmCallPayload) => p) as never },
      }),
    ).toThrow(expect.objectContaining({ kind: 'bad_request' }) as Error)
  })

  it('an include that returns a Promise at run time skips with a warning and leaks no rejection', async () => {
    const { sink, logger, client } = setup({
      include: (() => Promise.reject(new Error('late'))) as unknown as () => boolean,
    })
    await expect(client.generate(request(), { auth: AUTH })).resolves.toBeDefined()
    expect(sink.records).toHaveLength(1)
    expect(sink.payloads.size).toBe(0)
    expect(logger.find('llm.call.payload.dropped')?.fields).toMatchObject({
      stage: 'include',
    })
  })

  it('include runs at dispatch, once per attempt', async () => {
    let calls = 0
    const { client } = setup({
      include: () => {
        calls += 1
        return true
      },
    })
    await client.generate(request(), { auth: AUTH })
    expect(calls).toBe(1)
  })

  it('a sink that does not declare acceptsPayloads: one warning at createClient, no payload built, no second argument', async () => {
    const records: unknown[][] = []
    const sink = {
      record: (...args: unknown[]) => {
        records.push(args)
        return Promise.resolve()
      },
    }
    let includeCalls = 0
    const logger = new RecordingLogger()
    const client = createClient({
      adapters: [new FakeAdapter('p', [ok(), ok()])],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
      ]),
      sink,
      logger,
      payloads: {
        include: () => {
          includeCalls += 1
          return true
        },
      },
    })
    expect(
      logger.entries.filter((e) => e.message.startsWith('llm.config.payloads')),
    ).toHaveLength(1)
    await client.generate(request(), { auth: AUTH })
    await client.generate(request(), { auth: AUTH })
    expect(records.map((r) => r.length)).toEqual([1, 1])
    expect(includeCalls).toBe(0)
    expect(
      logger.entries.filter((e) => e.message.startsWith('llm.config.payloads')),
    ).toHaveLength(1)
  })
})
