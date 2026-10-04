/**
 * Standard JSON Schema on the wire (ADR-034), through the real `openai` SDK
 * that the xAI adapter drives. Only the global `fetch` is stubbed; the
 * assertions are on the JSON text that would go to `/v1/responses`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeProviders, createClient, LlmError } from '@gullabs/core'
import type { JsonValue, LlmRequest } from '@gullabs/core'
import { xaiProvider } from './provider.js'
import { sseResponse, synthesizeStreamEvents } from './test-sse.js'

let sent: Array<{ url: string; text: string; body: Record<string, unknown> }>

beforeEach(() => {
  sent = []
  vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
    const text = init.body ?? '{}'
    sent.push({
      url: String(url),
      text,
      body: JSON.parse(text) as Record<string, unknown>,
    })
    return sseResponse(
      synthesizeStreamEvents({
        id: 'resp_1',
        model: 'grok-4.6',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '{"zeta":"z"}', annotations: [] }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      }),
    )
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const client = createClient({ ...composeProviders([xaiProvider()]) })
const AUTH = { apiKey: 'xai-test' }

function generate(request: Partial<LlmRequest>) {
  return client.generate(
    {
      provider: 'xai',
      model: 'grok-4.6',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      ...request,
    },
    { auth: AUTH },
  )
}

async function rejected(request: Partial<LlmRequest>): Promise<LlmError> {
  const before = sent.length
  let error: unknown
  try {
    await generate(request)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(LlmError)
  expect(error).toMatchObject({ kind: 'bad_request', retryable: false, provider: 'xai' })
  expect(sent.length).toBe(before)
  return error as LlmError
}

const SCHEMA: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Answer',
  type: 'object',
  properties: {
    zeta: { type: 'string', description: 'reasoning goes first' },
    alpha: { type: ['integer', 'null'], minimum: 0 },
    kind: { const: 'answer' },
    shape: { anyOf: [{ $ref: '#/$defs/Circle' }, { type: 'null' }] },
  },
  required: ['zeta', 'alpha'],
  additionalProperties: false,
  $defs: { Circle: { type: 'object', properties: { r: { type: 'number' } } } },
}

describe('xAI wire: output.jsonSchema', () => {
  it('sends the schema verbatim, in order, as strict text.format', async () => {
    await generate({ output: { jsonSchema: SCHEMA } })
    expect(sent[0]?.url).toBe('https://api.x.ai/v1/responses')
    const format = (sent[0]?.body['text'] as { format: Record<string, unknown> }).format
    expect(format).toMatchObject({ type: 'json_schema', name: 'Answer', strict: true })
    expect(format['schema']).toEqual(SCHEMA)
    expect(sent[0]?.text).toContain(`"schema":${JSON.stringify(SCHEMA)}`)
  })

  it.each([
    ['oneOf (read as anyOf)', { oneOf: [{ type: 'string' }] }, '`oneOf`'],
    ['allOf', { allOf: [{ type: 'object' }] }, '`allOf`'],
    ['multipleOf', { type: 'number', multipleOf: 2 }, '`multipleOf`'],
    ['uniqueItems', { type: 'array', uniqueItems: true }, '`uniqueItems`'],
    [
      'propertyNames (z.record)',
      { type: 'object', propertyNames: {} },
      '`propertyNames`',
    ],
    [
      'a recursive $ref',
      { type: 'object', properties: { k: { $ref: '#' } } },
      'circular',
    ],
  ])('rejects %s before dispatch with the path', async (_name, schema, needle) => {
    const err = await rejected({ output: { jsonSchema: schema as JsonValue } })
    expect(err.message).toContain('output.jsonSchema')
    expect(err.message).toContain(needle)
  })

  it('accepts the no-op propertyNames of z.record(z.string(), X) and sends it verbatim', async () => {
    const record: JsonValue = {
      type: 'object',
      properties: {
        r: {
          type: 'object',
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'number' },
        },
      },
    }
    await generate({ output: { jsonSchema: record } })
    const format = (sent[0]?.body['text'] as { format: Record<string, unknown> }).format
    expect(format['schema']).toEqual(record)
  })

  it.each(['^[\\p{L}]+$', '^[\\p{L}\\s]+$'])(
    'rejects the property escape inside a character class: %s',
    async (pattern) => {
      const err = await rejected({
        output: {
          jsonSchema: { type: 'object', properties: { s: { type: 'string', pattern } } },
        },
      })
      expect(err.message).toContain('output.jsonSchema.properties.s')
      expect(err.message).toContain('property escape')
    },
  )

  it('rejects the OpenAPI dialect before dispatch', async () => {
    const nullable = await rejected({
      output: {
        jsonSchema: {
          type: 'object',
          properties: { a: { type: 'string', nullable: true } },
        },
      },
    })
    expect(nullable.message).toContain('output.jsonSchema.properties.a')
    expect(
      (await rejected({ output: { jsonSchema: { type: 'OBJECT' } } })).message,
    ).toContain('"OBJECT"')
  })
})

describe('xAI wire: tools[].inputJsonSchema', () => {
  const TOOL_SCHEMA: JsonValue = {
    type: 'object',
    properties: {
      zip: { type: 'string', pattern: '^\\d{5}$' },
      unit: { $ref: '#/$defs/Unit' },
    },
    required: ['zip'],
    $defs: { Unit: { type: 'string', enum: ['c', 'f'] } },
  }

  it('sends the tool schema verbatim as function parameters', async () => {
    await generate({
      tools: [
        { name: 'get_weather', description: 'Weather.', inputJsonSchema: TOOL_SCHEMA },
      ],
    })
    const tools = sent[0]?.body['tools'] as Array<Record<string, unknown>>
    expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather' })
    expect(tools[0]?.['parameters']).toEqual(TOOL_SCHEMA)
    expect(sent[0]?.text).toContain(`"parameters":${JSON.stringify(TOOL_SCHEMA)}`)
  })

  it('applies the same assertion to tool schemas, naming the tool index', async () => {
    const unenforced = await rejected({
      tools: [
        { name: 'ok', description: 'd', inputJsonSchema: TOOL_SCHEMA },
        {
          name: 'bad',
          description: 'd',
          inputJsonSchema: {
            type: 'object',
            properties: { k: { type: 'number', multipleOf: 5 } },
          },
        },
      ],
    })
    expect(unenforced.message).toContain('tools[1].inputJsonSchema.properties.k')
    const dialect = await rejected({
      tools: [
        {
          name: 't',
          description: 'd',
          inputJsonSchema: { type: 'object', properties: { a: { type: 'STRING' } } },
        },
      ],
    })
    expect(dialect.message).toContain('tools[0].inputJsonSchema.properties.a')
  })
})
