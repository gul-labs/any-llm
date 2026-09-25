/**
 * @gullabs/xai — fixture-backed contract tests.
 *
 * Feeds live-captured (and human-sanitized) xAI Responses API fixture
 * response bodies through `xaiAdapter` / `classifyXaiError`, proving the
 * adapter maps each recorded real-world shape correctly end-to-end.
 *
 * Fixtures live in `./__fixtures__/` and were captured against the live
 * xAI Responses API (grok-4.5 on 2026-07-09; grok-4.6 on 2026-08-12), then
 * grepped clean of any Authorization/Bearer/API-key-shaped strings before
 * being copied into this package.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { AdapterCtx, JsonValue, ResolvedRequest } from '@gullabs/core'
import { makeFakeXai } from '@gullabs/testing'
import { xaiAdapter, classifyXaiError } from './adapter.js'
import {
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  grok47ModelDescriptor,
} from './models.js'
import { makeTestDescriptor } from '../../core/src/test-model-descriptor.js'

/** Read + JSON.parse a fixture file at test time (no resolveJsonModule needed). */
function loadFixture<T = unknown>(name: string): T {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

interface FixtureCall {
  status: number
  body: Record<string, unknown>
}

// Named-property interfaces (not index signatures) so plain dot-notation
// access stays `FixtureCall`, not `FixtureCall | undefined`, under this
// repo's `noUncheckedIndexedAccess` tsconfig setting.
interface ReasoningMatrixFixture {
  low: FixtureCall
  high: FixtureCall
  none: FixtureCall
  bogus: FixtureCall
}
interface StructuredOutputFixture {
  text_format: FixtureCall
  response_format: FixtureCall
  empty_enum: FixtureCall
}
interface CachingFixture {
  call1_with_key: FixtureCall
  call2_with_key: FixtureCall
  call3_without_key: FixtureCall
}
interface MaxOutputTokensFixture {
  huge_max: FixtureCall
  tiny_max: FixtureCall
}
interface ErrorTaxonomyFixture {
  nonexistent_model: FixtureCall
  malformed_body: FixtureCall
  invalid_api_key: FixtureCall
}
interface NonStrictSchemaFixture extends FixtureCall {
  /** The verbatim `text.format` json_schema sent in the live 2026-07-09 probe. */
  requestSchema: { [k: string]: JsonValue }
}

const minimalFixture = loadFixture<FixtureCall>('02-responses-minimal.json')
const reasoningMatrixFixture = loadFixture<ReasoningMatrixFixture>(
  '03-reasoning-effort-matrix.json',
)
const structuredOutputFixture = loadFixture<StructuredOutputFixture>(
  '04-structured-output.json',
)
const cachingFixture = loadFixture<CachingFixture>('07-caching.json')
const maxOutputTokensFixture = loadFixture<MaxOutputTokensFixture>(
  '08-max-output-tokens.json',
)
const errorTaxonomyFixture = loadFixture<ErrorTaxonomyFixture>('09-error-taxonomy.json')
const nonStrictSchemaFixture = loadFixture<NonStrictSchemaFixture>(
  '10-non-strict-schema-accepted.json',
)
const multiMessageOutputFixture = loadFixture<FixtureCall>('11-multi-message-output.json')
const grok46XhighPriorityFixture = loadFixture<FixtureCall>(
  '12-grok-4-6-xhigh-priority.json',
)
const grok46EffortNoneFixture = loadFixture<FixtureCall>('13-grok-4-6-effort-none.json')

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    ...overrides,
  }
}

describe('fixture: 02-responses-minimal', () => {
  it('maps the minimal completed response end-to-end', async () => {
    const client = makeFakeXai(minimalFixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe("Hi! 👋 How's it going?")
    expect(result.reasoningText).toContain('The user said')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.inputTokens).toBe(208)
    expect(result.usage.cachedInputTokens).toBe(128)
    expect(result.usage.outputTokens).toBe(42)
    expect(result.usage.thinkingTokens).toBe(33)
    expect(result.usage.totalTokens).toBe(250)
    expect(result.servedServiceTier).toBe('default')
  })

  it('surfaces numeric xAI usage extras into details and non-numeric extras into providerMetadata', async () => {
    const client = makeFakeXai(minimalFixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    // Canonical counters stay canonical…
    expect(result.usage.details).toMatchObject({
      input: 208,
      output: 42,
      cached: 128,
      thinking: 33,
    })
    // …and every numeric xAI extra is surfaced under its raw name.
    expect(result.usage.details).toMatchObject({
      num_sources_used: 0,
      num_server_side_tools_used: 0,
      cost_in_usd_ticks: 4_760_000,
    })

    // Non-numeric extras go to providerMetadata (usage.raw keeps the full
    // verbatim payload separately).
    expect(result.providerMetadata).toEqual({
      context_details: { input_tokens: 208, output_tokens: 42 },
      metadata: { system_fingerprint: 'fp_a39489019fa99b6e' },
    })
    expect(result.usage.raw).toEqual(minimalFixture.body['usage'])
  })
})

describe('fixture: grok-4.6 contract (positive + negative)', () => {
  it('maps the live grok-4.6 xhigh / priority response', async () => {
    const client = makeFakeXai(grok46XhighPriorityFixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.6',
        config: { reasoning: { effort: 'xhigh' }, serviceTier: 'priority' },
        modelDescriptor: makeTestDescriptor({
          model: 'grok-4.6',
          provider: 'xai',
          capabilities: {
            admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            serviceTiers: ['priority'],
          },
        }),
      }),
      FAKE_CTX,
    )
    expect(result.model).toBe('grok-4.6')
    expect(result.servedServiceTier).toBe('priority')
    expect(result.text).toBe('Hi! How can I help you today?')
    expect(result.usage.thinkingTokens).toBe(173)
    const call = client.calls[0] as {
      reasoning?: { effort: string }
      service_tier?: string
    }
    expect(call.reasoning).toEqual({ effort: 'xhigh' })
    expect(call.service_tier).toBe('priority')
  })

  it('classifies the live grok-4.6 effort-none 400 as bad_request', () => {
    expect(
      classifyXaiError({
        status: grok46EffortNoneFixture.status,
        ...grok46EffortNoneFixture.body,
      }),
    ).toMatchObject({ kind: 'bad_request' })
  })

  it('rejects grok-4.6 effort none locally before dispatch', async () => {
    const client = makeFakeXai(grok46XhighPriorityFixture.body as never)
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'grok-4.6',
          config: { reasoning: { effort: 'none' } },
          modelDescriptor: makeTestDescriptor({
            model: 'grok-4.6',
            provider: 'xai',
            capabilities: {
              admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              serviceTiers: ['priority'],
            },
          }),
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })
})

describe('fixture: 03-reasoning-effort-matrix', () => {
  it('maps the low-effort branch', async () => {
    const client = makeFakeXai(reasoningMatrixFixture.low.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        config: { reasoning: { effort: 'low' } },
        modelDescriptor: makeTestDescriptor({
          model: 'grok-4.5',
          provider: 'xai',
          capabilities: { admittedReasoningEfforts: ['low', 'high'] },
        }),
      }),
      FAKE_CTX,
    )
    expect(result.usage.outputTokens).toBe(33)
    expect(result.usage.thinkingTokens).toBe(22)
  })

  it('maps the high-effort branch', async () => {
    const client = makeFakeXai(reasoningMatrixFixture.high.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        config: { reasoning: { effort: 'high' } },
        modelDescriptor: makeTestDescriptor({
          model: 'grok-4.5',
          provider: 'xai',
          capabilities: { admittedReasoningEfforts: ['low', 'high'] },
        }),
      }),
      FAKE_CTX,
    )
    expect(result.usage.outputTokens).toBe(81)
    expect(result.usage.thinkingTokens).toBe(70)
  })
})

describe('fixture: 04-structured-output', () => {
  it('maps the text_format success case, parsing rawStructured', async () => {
    const client = makeFakeXai(structuredOutputFixture.text_format.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
        },
      }),
      FAKE_CTX,
    )
    expect(result.rawStructured).toEqual({ name: 'Bob', age: 30 })
  })
})

describe('fixture: 07-caching', () => {
  it('maps call1_with_key (first call, low cache hit)', async () => {
    const client = makeFakeXai(cachingFixture.call1_with_key.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        config: { providerOptions: { xai: { promptCacheKey: 'anyllm-probe-1' } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.inputTokens).toBe(1234)
    expect(result.usage.cachedInputTokens).toBe(128)

    const call = client.calls[0] as { prompt_cache_key?: string }
    expect(call.prompt_cache_key).toBe('anyllm-probe-1')
  })

  it('maps call2_with_key (repeat call, high cache hit)', async () => {
    const client = makeFakeXai(cachingFixture.call2_with_key.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        config: { providerOptions: { xai: { promptCacheKey: 'anyllm-probe-1' } } },
      }),
      FAKE_CTX,
    )
    expect(result.usage.cachedInputTokens).toBe(1152)
  })

  it('maps call3_without_key (no prompt_cache_key sent)', async () => {
    const client = makeFakeXai(cachingFixture.call3_without_key.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.usage.cachedInputTokens).toBe(128)

    const call = client.calls[0] as { prompt_cache_key?: string }
    expect(call.prompt_cache_key).toBeUndefined()
  })
})

describe('fixture: 08-max-output-tokens', () => {
  it('maps huge_max (completed, no truncation)', async () => {
    const client = makeFakeXai(maxOutputTokensFixture.huge_max.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({ config: { maxOutputTokens: 100_000_000 } }),
      FAKE_CTX,
    )
    expect(result.finishReason).toBe('stop')

    const call = client.calls[0] as { max_output_tokens?: number }
    expect(call.max_output_tokens).toBe(100_000_000)
  })

  it('maps tiny_max (incomplete/max_output_tokens -> finishReason:"length")', async () => {
    const client = makeFakeXai(maxOutputTokensFixture.tiny_max.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({ config: { maxOutputTokens: 16 } }),
      FAKE_CTX,
    )
    expect(result.finishReason).toBe('length')
    expect(result.text).toContain('Ember of Aetheria')
  })

  it('tiny_max: numeric usage extras land in details, context_details/metadata in providerMetadata', async () => {
    const client = makeFakeXai(maxOutputTokensFixture.tiny_max.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({ config: { maxOutputTokens: 16 } }),
      FAKE_CTX,
    )
    expect(result.usage.details).toMatchObject({
      input: 214,
      output: 51,
      cached: 0,
      thinking: 35,
      num_sources_used: 0,
      num_server_side_tools_used: 0,
      cost_in_usd_ticks: 7_340_000,
    })
    expect(result.providerMetadata).toEqual({
      context_details: { input_tokens: 214, output_tokens: 51 },
      metadata: { system_fingerprint: 'fp_a39489019fa99b6e' },
    })
  })
})

describe('fixture: 10-non-strict-schema-accepted', () => {
  it('forwards a non-OpenAI-strict schema to xAI verbatim and maps the accepted response', async () => {
    const client = makeFakeXai(nonStrictSchemaFixture.body as never)
    const adapter = xaiAdapter({ client })

    // The fixture's `requestSchema` is the verbatim `text.format` json_schema
    // sent in the live probe: missing `additionalProperties: false` at the
    // root, `age` omitted from `required` (optional property), and a
    // `format: 'email'` keyword — none of which are legal under OpenAI-strict
    // json_schema rules, yet xAI's live Responses API accepted this with
    // `strict: true` and returned HTTP 200.
    const inputSchema = nonStrictSchemaFixture.requestSchema

    // Self-consistency guard: xAI echoes the request schema back in the
    // response body, so the fixture's requestSchema must match it exactly.
    const bodyText = nonStrictSchemaFixture.body['text'] as {
      format: { schema: unknown }
    }
    expect(inputSchema).toEqual(bodyText.format.schema)

    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: inputSchema }),
      FAKE_CTX,
    )

    // The adapter must forward the schema verbatim — no additionalProperties
    // injection, no required-array rewriting, no nullable-union rewriting.
    const call = client.calls[0] as {
      text?: { format?: { schema?: unknown; strict?: boolean } }
    }
    expect(call.text?.format?.schema).toEqual(inputSchema)
    expect(call.text?.format?.strict).toBe(true)

    expect(result.text).toBe(nonStrictSchemaFixture.body['output_text'])
    expect(result.finishReason).toBe('stop')
    expect(result.usage.inputTokens).toBe(288)
    expect(result.usage.outputTokens).toBe(194)
    expect(result.rawStructured).toEqual({ name: 'Bob', email: 'bob@example.com' })
  })
})

describe('fixture: 11-multi-message-output', () => {
  it('uses the LAST message item as text, discarding the earlier superseded one', async () => {
    const client = makeFakeXai(multiMessageOutputFixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: {
          type: 'object',
          properties: { report: { type: 'object' } },
          required: ['report'],
        },
      }),
      FAKE_CTX,
    )

    // The result text is exactly the LAST message item's output_text — NOT
    // the two documents concatenated (which would be invalid JSON, and is
    // exactly the shape of the live defect this fixture is modeled on).
    expect(result.text).toBe(
      '{"report":{"items":[{"id":"item-1","severity":"high"}],"status":"final"}}',
    )
    expect(result.rawStructured).toEqual({
      report: {
        items: [{ id: 'item-1', severity: 'high' }],
        status: 'final',
      },
    })

    // A warning names the dropped item count.
    expect(result.warnings).toEqual([
      {
        type: 'other',
        message:
          'xai: response contained 2 message output items; using the last one and discarding 1 earlier message item(s).',
      },
    ])

    // reasoningText assembly from the (single) reasoning item is unaffected.
    expect(result.reasoningText).toContain('Reviewing the documents')
  })
})

describe('fixture: 09-error-taxonomy', () => {
  it('classifies nonexistent_model (400) as bad_request', () => {
    const fixture = errorTaxonomyFixture.nonexistent_model
    const result = classifyXaiError({ status: fixture.status, ...fixture.body })
    expect(result.kind).toBe('bad_request')
  })

  it('classifies malformed_body (422) as bad_request', () => {
    const fixture = errorTaxonomyFixture.malformed_body
    const result = classifyXaiError({ status: fixture.status, ...fixture.body })
    expect(result.kind).toBe('bad_request')
  })

  it('classifies invalid_api_key (400, recorded body signature) as invalid_auth', () => {
    const fixture = errorTaxonomyFixture.invalid_api_key
    // openai-SDK shape: APIError hoists the body's `error` field onto `.error`.
    const result = classifyXaiError({ status: fixture.status, ...fixture.body })
    expect(result.kind).toBe('invalid_auth')
  })

  it('classifies invalid_api_key with the full parsed body on .error as invalid_auth', () => {
    const fixture = errorTaxonomyFixture.invalid_api_key
    const result = classifyXaiError({ status: fixture.status, error: fixture.body })
    expect(result.kind).toBe('invalid_auth')
  })
})

describe('fixture: 15-safety-check-403', () => {
  const safetyFixture = loadFixture<{
    safety_check_cyber: {
      status: number
      error: string
    }
  }>('15-safety-check-403.json')

  it('classifies the recorded string-body 403 as content_filter', () => {
    const captured = safetyFixture.safety_check_cyber
    const result = classifyXaiError({
      status: captured.status,
      error: captured.error,
    })
    expect(result.kind).toBe('content_filter')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.provider).toBe('xai')
  })
})

describe('fixture: 17-web-search', () => {
  it('maps live search annotations to citations and flattens tool counters', async () => {
    const fixture = loadFixture<FixtureCall>('17-web-search.json')
    const adapter = xaiAdapter({
      client: makeFakeXai(fixture.body as never),
    })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.6',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'search' }] }],
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
        modelDescriptor: grok46ModelDescriptor,
      },
      {
        auth: { apiKey: 'test-key' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
    )
    expect(result.citations?.some((c) => c.url.includes('docs.x.ai'))).toBe(true)
    expect(result.usage.details.web_search_calls).toBe(1)
    expect(result.usage.details.server_tools_requested).toBe(1)
  })
})

describe('fixture: 18-structured-search', () => {
  it('allows structured output combined with search tools', async () => {
    const fixture = loadFixture<FixtureCall>('18-structured-search.json')
    const adapter = xaiAdapter({
      client: makeFakeXai(fixture.body as never),
    })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.6',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'search' }] }],
        outputJsonSchema: {
          type: 'object',
          properties: { window: { type: 'string' } },
          required: ['window'],
        },
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
        modelDescriptor: grok46ModelDescriptor,
      },
      {
        auth: { apiKey: 'test-key' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
    )
    expect(result.rawStructured).toEqual({ window: '500000' })
    expect(result.usage.details.web_search_calls).toBe(2)
    expect(result.citations?.length).toBeGreaterThan(0)
  })
})

describe('fixture: 20-grok-4-5-effort-medium', () => {
  it('maps the live medium-effort 200', async () => {
    const fixture = loadFixture<FixtureCall>('20-grok-4-5-effort-medium.json')
    expect(fixture.status).toBe(200)
    const adapter = xaiAdapter({ client: makeFakeXai(fixture.body as never) })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'ok' }] }],
        config: {},
        modelDescriptor: grok45ModelDescriptor,
      },
      {
        auth: { apiKey: 'test-key' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
    )
    expect(result.finishReason).toBe('stop')
    expect(result.text?.toLowerCase()).toContain('ok')
  })
})

describe('fixture: 20b-grok-4-5-effort-none', () => {
  it('records live none-effort 400', () => {
    const fixture = loadFixture<FixtureCall>('20b-grok-4-5-effort-none.json')
    expect(fixture.status).toBe(400)
    const err = classifyXaiError({ status: fixture.status, error: fixture.body })
    expect(err.kind).toBe('bad_request')
  })
})

describe('fixture: 21-function-call-first', () => {
  it('maps the live function_call output item', async () => {
    const fixture = loadFixture<FixtureCall>('21-function-call-first.json')
    const adapter = xaiAdapter({ client: makeFakeXai(fixture.body as never) })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.6',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'temp' }] }],
        config: {},
        tools: [
          {
            name: 'get_temperature',
            description: 'Get temperature',
            inputJsonSchema: { type: 'object' },
          },
        ],
        modelDescriptor: grok46ModelDescriptor,
      },
      {
        auth: { apiKey: 'test-key' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
    )
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls?.[0]?.toolName).toBe('get_temperature')
    expect(result.toolCalls?.[0]?.toolCallId).toMatch(/^call-/)
  })
})

describe('fixture: grok-4.7 schema accepts the grok-4.6 effort set', () => {
  it('dispatches grok-4.7 with xhigh and priority', async () => {
    const client = makeFakeXai(grok46XhighPriorityFixture.body as never)
    const adapter = xaiAdapter({ client })
    await adapter.run(
      makeResolvedReq({
        model: 'grok-4.7',
        config: { reasoning: { effort: 'xhigh' }, serviceTier: 'priority' },
        modelDescriptor: grok47ModelDescriptor,
      }),
      FAKE_CTX,
    )
    const call = client.calls[0] as { model?: string; service_tier?: string }
    expect(call.model).toBe('grok-4.7')
    expect(call.service_tier).toBe('priority')
  })

  it('rejects grok-4.7 effort none before dispatch', async () => {
    const client = makeFakeXai(grok46XhighPriorityFixture.body as never)
    const adapter = xaiAdapter({ client })
    await expect(
      adapter.run(
        makeResolvedReq({
          model: 'grok-4.7',
          config: { reasoning: { effort: 'none' } },
          modelDescriptor: grok47ModelDescriptor,
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(client.calls).toHaveLength(0)
  })
})

describe('fixture: 22-function-call-replay-store-false', () => {
  it('maps the live store:false replay final message', async () => {
    const fixture = loadFixture<FixtureCall>('22-function-call-replay-store-false.json')
    expect(fixture.status).toBe(200)
    const adapter = xaiAdapter({ client: makeFakeXai(fixture.body as never) })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.6',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'temp' }] }],
        config: {},
        modelDescriptor: grok46ModelDescriptor,
      },
      {
        auth: { apiKey: 'test-key' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
    )
    expect(result.text).toMatch(/59/)
  })
})
