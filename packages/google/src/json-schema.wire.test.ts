/**
 * Standard JSON Schema on the wire (ADR-034), through the real `@google/genai`
 * request transformers. Only `fetch` is stubbed, so the assertions are on the
 * exact JSON text that would go to Google: `responseJsonSchema` and
 * `parametersJsonSchema` verbatim, in the host's key order, never the OpenAPI
 * fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeProviders, createClient, LlmError } from '@gullabs/core'
import type { JsonValue, LlmRequest } from '@gullabs/core'
import { googleProvider } from './provider.js'

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
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: '{"zeta":"z","alpha":1}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 3,
          totalTokenCount: 7,
        },
        modelVersion: 'test-version',
        responseId: 'r1',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const client = createClient({ ...composeProviders([googleProvider()]) })
const AUTH = { apiKey: 'test-key' }
const MODEL = 'gemini-3.1-flash-lite'

function generate(request: Partial<LlmRequest>) {
  return client.generate(
    {
      provider: 'google',
      model: MODEL,
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
  expect(error).toMatchObject({
    kind: 'bad_request',
    retryable: false,
    provider: 'google',
  })
  expect(sent.length).toBe(before)
  return error as LlmError
}

// Deliberately not alphabetical: Google must see the host's order.
const SCHEMA: JsonValue = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Answer',
  type: 'object',
  properties: {
    zeta: { type: 'string', description: 'reasoning goes first' },
    alpha: { type: ['integer', 'null'], minimum: 0 },
    kind: { type: 'string', enum: ['a', 'b'] },
    shape: { anyOf: [{ $ref: '#/$defs/Circle' }, { type: 'null' }] },
  },
  required: ['zeta', 'alpha'],
  additionalProperties: false,
  $defs: { Circle: { type: 'object', properties: { r: { type: 'number' } } } },
}

describe('Google wire: output.jsonSchema', () => {
  it('sends responseJsonSchema verbatim with key order, and no OpenAPI field', async () => {
    const result = await generate({ output: { jsonSchema: SCHEMA } })
    expect(result.outputParsed).toBe(true)

    expect(sent).toHaveLength(1)
    const config = sent[0]?.body['generationConfig'] as Record<string, unknown>
    expect(config['responseMimeType']).toBe('application/json')
    expect(config['responseJsonSchema']).toEqual(SCHEMA)
    expect(config).not.toHaveProperty('responseSchema')
    // The exact serialisation: same keys, same order, `$schema`/`$defs`/`$ref`
    // untouched and type names still lowercase.
    expect(sent[0]?.text).toContain(`"responseJsonSchema":${JSON.stringify(SCHEMA)}`)
    expect(
      Object.keys((config['responseJsonSchema'] as { properties: object }).properties),
    ).toEqual(['zeta', 'alpha', 'kind', 'shape'])
  })

  it.each([
    [
      'const (z.literal)',
      { type: 'object', properties: { k: { const: 'x' } } },
      '`const`',
    ],
    [
      'oneOf (z.discriminatedUnion)',
      { oneOf: [{ type: 'object' }, { type: 'object' }] },
      '`oneOf`',
    ],
    ['allOf', { allOf: [{ type: 'object' }] }, '`allOf`'],
    ['uniqueItems', { type: 'array', uniqueItems: true }, '`uniqueItems`'],
    ['multipleOf', { type: 'number', multipleOf: 2 }, '`multipleOf`'],
    ['exclusiveMinimum', { type: 'number', exclusiveMinimum: 0 }, '`exclusiveMinimum`'],
    [
      'propertyNames (z.record)',
      { type: 'object', propertyNames: {} },
      '`propertyNames`',
    ],
  ])('rejects %s before dispatch with the path', async (_name, schema, keyword) => {
    const err = await rejected({ output: { jsonSchema: schema as JsonValue } })
    expect(err.message).toContain('output.jsonSchema')
    expect(err.message).toContain(keyword)
  })

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
    const upper = await rejected({ output: { jsonSchema: { type: 'OBJECT' } } })
    expect(upper.message).toContain('"OBJECT"')
  })
})

describe('Google wire: tools[].inputJsonSchema', () => {
  const TOOL_SCHEMA: JsonValue = {
    type: 'object',
    properties: {
      zip: { type: 'string', pattern: '^\\d{5}$' },
      city: { type: 'string' },
      unit: { $ref: '#/$defs/Unit' },
    },
    required: ['zip'],
    $defs: { Unit: { type: 'string', enum: ['c', 'f'] } },
  }

  it('sends parametersJsonSchema verbatim and never `parameters`', async () => {
    await generate({
      tools: [
        { name: 'get_weather', description: 'Weather.', inputJsonSchema: TOOL_SCHEMA },
      ],
    })
    const tools = sent[0]?.body['tools'] as Array<{
      functionDeclarations: Array<Record<string, unknown>>
    }>
    const declaration = tools[0]?.functionDeclarations[0] as Record<string, unknown>
    expect(declaration['name']).toBe('get_weather')
    expect(declaration['parametersJsonSchema']).toEqual(TOOL_SCHEMA)
    expect(declaration).not.toHaveProperty('parameters')
    expect(sent[0]?.text).toContain(
      `"parametersJsonSchema":${JSON.stringify(TOOL_SCHEMA)}`,
    )
  })

  it('rejects an unenforced keyword in a tool schema, naming the tool index', async () => {
    const err = await rejected({
      tools: [
        { name: 'ok', description: 'd', inputJsonSchema: TOOL_SCHEMA },
        {
          name: 'bad',
          description: 'd',
          inputJsonSchema: { type: 'object', properties: { k: { const: 1 } } },
        },
      ],
    })
    expect(err.message).toContain('tools[1].inputJsonSchema.properties.k')
  })

  it('rejects a nullable tool property before dispatch', async () => {
    const err = await rejected({
      tools: [
        {
          name: 't',
          description: 'd',
          inputJsonSchema: {
            type: 'object',
            properties: { a: { type: 'string', nullable: true } },
          },
        },
      ],
    })
    expect(err.message).toContain('tools[0].inputJsonSchema.properties.a')
  })
})
