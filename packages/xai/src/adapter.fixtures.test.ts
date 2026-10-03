/**
 * @gullabs/xai — fixture-backed contract tests.
 *
 * Feeds live-captured (and human-sanitized) xAI Responses API fixture
 * response bodies through `xaiAdapter` / `classifyXaiError`, proving the
 * adapter maps each recorded real-world shape correctly end-to-end.
 *
 * Fixtures live in `./__fixtures__/` and were captured against the live
 * xAI Responses API (grok-4.5 on 2026-07-09, grok-4.6 on 2026-08-12,
 * grok-4.7 on 2026-09-25), then
 * grepped clean of any Authorization/Bearer/API-key-shaped strings before
 * being copied into this package.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createClient } from '@gullabs/core'
import type { AdapterCtx, JsonValue, ResolvedRequest } from '@gullabs/core'
import { makeFakeXai, RecordingSink } from '@gullabs/testing'
import { xaiAdapter, classifyXaiError } from './adapter.js'
import type { XaiReplayState } from './client.js'
import { assertXaiOutputJsonSchema } from './output-schema.js'
import { computeXaiCost, xaiPricingSource } from './pricing.js'
import {
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  grok47ModelDescriptor,
  xaiRegistry,
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
const grok47PriorityFixture = loadFixture<FixtureCall>('24-grok-4-7-priority.json')
const grok47EffortNoneFixture = loadFixture<FixtureCall>('25-grok-4-7-effort-none.json')

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

describe('fixture: grok-4.5 priority (live 2026-09-25)', () => {
  it('maps the served tier and reconciles the 2× bill', async () => {
    const fixture = loadFixture<FixtureCall>('23-grok-4-5-priority.json')
    const client = makeFakeXai(fixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.5',
        config: { serviceTier: 'priority' },
        modelDescriptor: grok45ModelDescriptor,
      }),
      FAKE_CTX,
    )
    expect(result.servedServiceTier).toBe('priority')
    expect((client.calls[0] as { service_tier?: string }).service_tier).toBe('priority')
    const cost = computeXaiCost('grok-4.5', result.usage, result.servedServiceTier)
    expect(cost.usd).toBe(result.usage.details.cost_in_usd_ticks! * 1e-10)
    expect(cost.confidence).toBe('exact')
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

describe('fixture: 19-x-search (pre-2026-09-21 billing policy)', () => {
  it('retains billed ticks but leaves snapshot cost unpriced without item counters', async () => {
    const fixture = loadFixture<FixtureCall>('19-x-search.json')
    const adapter = xaiAdapter({ client: makeFakeXai(fixture.body as never) })
    const result = await adapter.run(
      {
        provider: 'xai',
        model: 'grok-4.6',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'search X' }] }],
        config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
        modelDescriptor: grok46ModelDescriptor,
      },
      FAKE_CTX,
    )
    expect(result.usage.details.x_search_calls).toBe(2)
    expect(result.usage.details.x_posts_fetched).toBeUndefined()
    expect(result.usage.details.x_users_fetched).toBeUndefined()
    expect(result.usage.details.server_tools_missing).toBe(1)
    expect(result.usage.details.cost_in_usd_ticks).toBe(289_600_000)
    const cost = computeXaiCost('grok-4.6', result.usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('x_posts_fetched')
    expect(cost.confidence).toBe('estimated')
  })
})

describe('fixtures: P-X1 live X Search item billing (2026-09-26)', () => {
  it.each([
    ['26-x-posts.json', 10, 0, 1_038_920_000],
    ['27-x-users.json', 0, 12, 1_476_220_000],
  ])(
    'reconciles %s with the provider billed ticks',
    async (name, posts, users, ticks) => {
      const fixture = loadFixture<FixtureCall>(name)
      expect(fixture.status).toBe(200)
      const client = makeFakeXai(fixture.body as never)
      const result = await xaiAdapter({ client }).run(
        makeResolvedReq({
          model: 'grok-4.7',
          config: { providerOptions: { xai: { tools: [{ type: 'x_search' }] } } },
          modelDescriptor: grok47ModelDescriptor,
        }),
        FAKE_CTX,
      )
      expect((client.calls[0] as { tools?: unknown }).tools).toEqual([
        { type: 'x_search' },
      ])
      expect(result.usage.details).toMatchObject({
        x_search_calls: 4,
        x_posts_fetched: posts,
        x_users_fetched: users,
        cost_in_usd_ticks: ticks,
      })
      expect(result.usage.details.server_tools_missing).toBeUndefined()
      const cost = computeXaiCost('grok-4.7', result.usage, result.servedServiceTier)
      expect(cost.usd).toBe(ticks * 1e-10)
      expect(cost.confidence).toBe('exact')
    },
  )
})

describe('fixture: P-X3 grok-4.7 encrypted reasoning replay', () => {
  it('replays a live assistant message and web-search item on the next turn', async () => {
    const fixture = loadFixture<{
      request: {
        first_input: { content: [{ text: string }] }
        next_input: { content: [{ text: string }] }
        followup_input_length: number
        followup_input_sha256: string
      }
      first: {
        status: number
        output: Array<Record<string, unknown>>
        usage: Record<string, unknown>
      }
      second: {
        status: number
        output: Array<Record<string, unknown>>
        usage: Record<string, unknown>
      }
    }>('30-grok-4-7-search-replay.json')
    expect(fixture.first.status).toBe(200)
    expect(fixture.second.status).toBe(200)
    expect(fixture.first.output.some((item) => item['type'] === 'web_search_call')).toBe(
      true,
    )
    expect(fixture.first.output.some((item) => item['type'] === 'message')).toBe(true)

    const wireClient = makeFakeXai([
      {
        model: 'grok-4.7',
        status: 'completed',
        output: fixture.first.output,
        usage: fixture.first.usage,
      },
      {
        model: 'grok-4.7',
        status: 'completed',
        output: fixture.second.output,
        usage: fixture.second.usage,
      },
    ] as never)
    const adapter = xaiAdapter({ client: wireClient })
    const first = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: fixture.request.first_input.content[0].text }],
          },
        ],
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      FAKE_CTX,
    )
    const second = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        transientProviderState: first.transientProviderState!,
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: fixture.request.next_input.content[0].text }],
          },
        ],
      }),
      FAKE_CTX,
    )
    expect(second.text).toContain('Grok API')
    const replayWire = wireClient.calls[1] as { input: unknown[]; tools?: unknown }
    expect(replayWire.input).toEqual([
      fixture.request.first_input,
      ...fixture.first.output,
      fixture.request.next_input,
    ])
    expect(replayWire.input).toHaveLength(fixture.request.followup_input_length)
    expect(
      createHash('sha256').update(JSON.stringify(replayWire.input)).digest('hex'),
    ).toBe(fixture.request.followup_input_sha256)
    expect(replayWire.tools).toBeUndefined()
  })

  it('continues a function result through the public client without losing reasoning', async () => {
    const fixture = loadFixture<{ first: FixtureCall; second: FixtureCall }>(
      '28-grok-4-7-replay.json',
    )
    const wireClient = makeFakeXai([
      fixture.first.body as never,
      fixture.second.body as never,
    ])
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [xaiAdapter({ client: wireClient })],
      pricingSources: { xai: xaiPricingSource() },
      modelRegistry: xaiRegistry,
      sink,
    })
    const tool = {
      name: 'add_numbers',
      description: 'Add two integers',
      inputJsonSchema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    }
    const first = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.7',
        tools: [tool],
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'text',
                text: 'Use add_numbers to add 2 and 3, then answer with the result.',
              },
            ],
          },
        ],
      },
      { auth: { apiKey: 'test-key' } },
    )
    const call = first.toolCalls?.[0]
    expect(call).toBeDefined()
    const second = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.7',
        tools: [tool],
        transientProviderState: first.transientProviderState!,
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: call!.toolCallId,
                toolName: call!.toolName,
                result: 5,
              },
            ],
          },
        ],
      },
      { auth: { apiKey: 'test-key' } },
    )
    expect(second.text).toBe('The result is 5.')
    expect((wireClient.calls[1] as { input: unknown[] }).input).toEqual([
      ...(first.transientProviderState as unknown as XaiReplayState).xai.input,
      { type: 'function_call_output', call_id: call!.toolCallId, output: '5' },
    ])
    expect(sink.records).toHaveLength(2)
    expect(JSON.stringify(sink.records)).not.toContain('encrypted_content')
  })

  it('round trips the original reasoning and function-call output in order', async () => {
    const fixture = loadFixture<{ first: FixtureCall; second: FixtureCall }>(
      '28-grok-4-7-replay.json',
    )
    expect(fixture.first.status).toBe(200)
    expect(fixture.second.status).toBe(200)
    const originalOutput = fixture.first.body['output'] as Array<Record<string, unknown>>
    expect(originalOutput.map((item) => item['type'])).toEqual([
      'reasoning',
      'function_call',
    ])
    expect(originalOutput[0]?.['encrypted_content']).toEqual(expect.any(String))
    const tool = {
      name: 'add_numbers',
      description: 'Add two integers',
      inputJsonSchema: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    }
    const userMessage = {
      role: 'user' as const,
      parts: [
        {
          kind: 'text' as const,
          text: 'Use add_numbers to add 2 and 3, then answer with the result.',
        },
      ],
    }
    const firstResult = await xaiAdapter({
      client: makeFakeXai(fixture.first.body as never),
    }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        messages: [userMessage],
        tools: [tool],
        modelDescriptor: grok47ModelDescriptor,
      }),
      FAKE_CTX,
    )
    const replay = firstResult.transientProviderState as unknown as XaiReplayState
    expect(replay.xai.input.slice(1)).toEqual(originalOutput)
    expect(JSON.stringify(firstResult.providerMetadata)).not.toContain(
      'encrypted_content',
    )
    const call = firstResult.toolCalls?.[0]
    expect(call).toBeDefined()
    const client = makeFakeXai(fixture.second.body as never)
    const secondResult = await xaiAdapter({ client }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: call!.toolCallId,
                toolName: call!.toolName,
                result: 5,
              },
            ],
          },
        ],
        tools: [tool],
        transientProviderState: replay as unknown as JsonValue,
        modelDescriptor: grok47ModelDescriptor,
      }),
      FAKE_CTX,
    )
    expect(secondResult.text).toBe('The result is 5.')
    const wire = client.calls[0] as { input: unknown[]; store: boolean }
    expect(wire.store).toBe(false)
    expect(wire.input).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Use add_numbers to add 2 and 3, then answer with the result.',
          },
        ],
      },
      ...replay.xai.input.slice(1),
      { type: 'function_call_output', call_id: call!.toolCallId, output: '5' },
    ])
    expect(
      (secondResult.transientProviderState as unknown as XaiReplayState).xai.input,
    ).toEqual([...wire.input, ...(fixture.second.body['output'] as unknown[])])

    const nextState = secondResult.transientProviderState as unknown as XaiReplayState
    const thirdFixture = loadFixture<
      FixtureCall & {
        request: {
          next_input: { role: 'user'; content: [{ type: 'input_text'; text: string }] }
          followup_input_length: number
          followup_input_sha256: string
          followup_tools_omitted: boolean
        }
      }
    >('31-grok-4-7-third-turn.json')
    expect(thirdFixture.status).toBe(200)
    const thirdClient = makeFakeXai(thirdFixture.body as never)
    const thirdResult = await xaiAdapter({ client: thirdClient }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        transientProviderState: nextState as unknown as JsonValue,
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: thirdFixture.request.next_input.content[0].text },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    expect(thirdResult.text).toContain('sum of 2 and 3')
    const thirdWire = thirdClient.calls[0] as { input: unknown[]; tools?: unknown }
    expect(thirdWire.input).toEqual([
      ...nextState.xai.input,
      thirdFixture.request.next_input,
    ])
    expect(thirdWire.input).toHaveLength(thirdFixture.request.followup_input_length)
    expect(
      createHash('sha256').update(JSON.stringify(thirdWire.input)).digest('hex'),
    ).toBe(thirdFixture.request.followup_input_sha256)
    expect(thirdFixture.request.followup_tools_omitted).toBe(true)
    expect(thirdWire.tools).toBeUndefined()
  })

  it('keeps reasoning before assistant text and a function call in mixed output', async () => {
    const fixture = loadFixture<{ first: FixtureCall; second: FixtureCall }>(
      '28-grok-4-7-replay.json',
    )
    const body = structuredClone(fixture.first.body)
    const original = body['output'] as Array<Record<string, unknown>>
    const mixed = [
      original[0],
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will calculate it.' }],
      },
      original[1],
    ]
    body['output'] = mixed
    const user = {
      role: 'user' as const,
      parts: [{ kind: 'text' as const, text: '2+3?' }],
    }
    const first = await xaiAdapter({ client: makeFakeXai(body as never) }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        messages: [user],
      }),
      FAKE_CTX,
    )
    const state = first.transientProviderState as unknown as XaiReplayState
    expect(state.xai.input.slice(1)).toEqual(mixed)
    const call = first.toolCalls?.[0]
    expect(call).toBeDefined()
    const client = makeFakeXai(fixture.second.body as never)
    await xaiAdapter({ client }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        transientProviderState: state as unknown as JsonValue,
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: call!.toolCallId,
                toolName: call!.toolName,
                result: 5,
              },
            ],
          },
        ],
      }),
      FAKE_CTX,
    )
    expect((client.calls[0] as { input: unknown[] }).input).toEqual([
      state.xai.input[0],
      ...mixed,
      { type: 'function_call_output', call_id: call!.toolCallId, output: '5' },
    ])
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

describe('fixtures: live grok-4.7 priority and rejected effort', () => {
  it('maps the live priority response and dispatches the admitted tier', async () => {
    expect(grok47PriorityFixture.status).toBe(200)
    const client = makeFakeXai(grok47PriorityFixture.body as never)
    const adapter = xaiAdapter({ client })
    const result = await adapter.run(
      makeResolvedReq({
        model: 'grok-4.7',
        config: { serviceTier: 'priority' },
        modelDescriptor: grok47ModelDescriptor,
      }),
      FAKE_CTX,
    )
    expect(result.model).toBe('grok-4.7')
    expect(result.text).toBe('OK')
    expect(result.servedServiceTier).toBe('priority')
    const billedTicks = (
      grok47PriorityFixture.body['usage'] as { cost_in_usd_ticks: number }
    ).cost_in_usd_ticks
    expect(
      computeXaiCost(result.model, result.usage, result.servedServiceTier).usd,
    ).toBeCloseTo(billedTicks * 1e-10, 10)
    const call = client.calls[0] as { model?: string; service_tier?: string }
    expect(call.model).toBe('grok-4.7')
    expect(call.service_tier).toBe('priority')
  })

  it('rejects grok-4.7 effort none before dispatch', async () => {
    expect(grok47EffortNoneFixture.status).toBe(400)
    expect(
      classifyXaiError({
        status: grok47EffortNoneFixture.status,
        error: grok47EffortNoneFixture.body,
      }).kind,
    ).toBe('bad_request')
    const client = makeFakeXai(grok47PriorityFixture.body as never)
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

// ---------------------------------------------------------------------------
// Live 2026-10-02: server tool choice, turn cap, strict-schema dialect
// ---------------------------------------------------------------------------

interface LiveCall extends FixtureCall {
  request: Record<string, unknown>
}

const LIVE_MODELS = [
  ['grok_4_5', grok45ModelDescriptor],
  ['grok_4_6', grok46ModelDescriptor],
  ['grok_4_7', grok47ModelDescriptor],
] as const

function billedTicks(call: FixtureCall): number {
  return (call.body['usage'] as { cost_in_usd_ticks: number }).cost_in_usd_ticks
}

/** Snapshot cost vs provider ticks (1 tick = 1e-10 USD), within per-lane rounding. */
function expectCostMatchesTicks(microUsd: number | null, ticks: number): void {
  expect(microUsd).not.toBeNull()
  expect(Math.abs((microUsd as number) - ticks / 10_000)).toBeLessThanOrEqual(2)
}

describe('fixture: 32-server-tool-choice (live 2026-10-02)', () => {
  const fixture = loadFixture<Record<string, LiveCall>>('32-server-tool-choice.json')

  it.each(LIVE_MODELS)(
    'required_%s forces a search before the message and prices to the billed ticks',
    async (key, modelDescriptor) => {
      const call = fixture[`required_${key}`] as LiveCall
      expect(call.status).toBe(200)
      expect(call.request['tool_choice']).toBe('required')
      const output = call.body['output'] as Array<{ type: string }>
      const firstSearch = output.findIndex((item) => item.type === 'web_search_call')
      const firstMessage = output.findIndex((item) => item.type === 'message')
      expect(firstSearch).toBeGreaterThanOrEqual(0)
      expect(firstSearch).toBeLessThan(firstMessage)

      const client = makeFakeXai(call.body as never)
      const result = await xaiAdapter({ client }).run(
        makeResolvedReq({
          model: modelDescriptor.model,
          modelDescriptor,
          config: {
            providerOptions: {
              xai: { tools: [{ type: 'web_search' }], toolChoice: 'required' },
            },
          },
        }),
        FAKE_CTX,
      )
      expect((client.calls[0] as { tool_choice?: unknown }).tool_choice).toBe('required')
      expect(result.text).toContain('24')
      expect(result.warnings).toEqual([])
      expect(result.usage.details.web_search_calls).toBeGreaterThanOrEqual(1)
      expect(result.usage.details.web_search_calls).toBe(
        result.usage.details.num_server_side_tools_used,
      )
      const cost = computeXaiCost(
        modelDescriptor.model,
        result.usage,
        result.servedServiceTier,
      )
      expect(cost.confidence).toBe('exact')
      expect(cost.details.tools).toBe(result.usage.details.web_search_calls! * 5_000)
      expectCostMatchesTicks(cost.microUsd, billedTicks(call))
    },
  )

  it.each(LIVE_MODELS)(
    'none_%s runs no search and still prices exactly',
    async (key, modelDescriptor) => {
      const call = fixture[`none_${key}`] as LiveCall
      expect(call.status).toBe(200)
      const usage = call.body['usage'] as Record<string, unknown>
      expect(usage['num_server_side_tools_used']).toBe(0)
      expect(usage['server_side_tool_usage_details']).toBeUndefined()

      const result = await xaiAdapter({ client: makeFakeXai(call.body as never) }).run(
        makeResolvedReq({
          model: modelDescriptor.model,
          modelDescriptor,
          config: {
            providerOptions: {
              xai: { tools: [{ type: 'web_search' }], toolChoice: 'none' },
            },
          },
        }),
        FAKE_CTX,
      )
      expect(result.warnings).toEqual([])
      expect(result.usage.details.web_search_calls).toBeUndefined()
      expect(result.usage.details.server_tools_missing).toBeUndefined()
      const cost = computeXaiCost(
        modelDescriptor.model,
        result.usage,
        result.servedServiceTier,
      )
      expect(cost.confidence).toBe('exact')
      expect(cost.details.tools).toBe(0)
      expectCostMatchesTicks(cost.microUsd, billedTicks(call))
    },
  )

  it.each(LIVE_MODELS)(
    'structured_%s combines forced search with a strict schema',
    async (key, modelDescriptor) => {
      const call = fixture[`structured_${key}`] as LiveCall
      expect(call.status).toBe(200)
      const format = (call.request['text'] as { format: { schema: JsonValue } }).format
      const result = await xaiAdapter({ client: makeFakeXai(call.body as never) }).run(
        makeResolvedReq({
          model: modelDescriptor.model,
          modelDescriptor,
          outputJsonSchema: format.schema,
          config: {
            providerOptions: {
              xai: { tools: [{ type: 'web_search' }], toolChoice: 'required' },
            },
          },
        }),
        FAKE_CTX,
      )
      expect(result.rawStructured).toMatchObject({ version: '24' })
      expect(result.usage.details.web_search_calls).toBeGreaterThanOrEqual(1)
      expect(result.warnings).toEqual([])
    },
  )

  it('keeps a forced server-call-first output in grok-4.7 replay state', async () => {
    const call = fixture['required_grok_4_7'] as LiveCall
    const result = await xaiAdapter({ client: makeFakeXai(call.body as never) }).run(
      makeResolvedReq({
        model: 'grok-4.7',
        modelDescriptor: grok47ModelDescriptor,
        config: {
          providerOptions: {
            xai: { tools: [{ type: 'web_search' }], toolChoice: 'required' },
          },
        },
      }),
      FAKE_CTX,
    )
    const state = result.transientProviderState as unknown as XaiReplayState
    const types = (state.xai.input as Array<{ type?: string }>).map((item) => item.type)
    expect(types.indexOf('web_search_call')).toBeGreaterThan(0)
    expect(types.indexOf('web_search_call')).toBeLessThan(types.lastIndexOf('message'))
  })
})

describe('fixture: 33-max-turns-not-enforced (live 2026-10-02)', () => {
  const fixture = loadFixture<Record<string, LiveCall>>('33-max-turns-not-enforced.json')
  const cases = [
    'grok_4_5_required',
    'grok_4_5_auto',
    'grok_4_5_max_turns_2',
    'grok_4_6_required',
    'grok_4_7_required',
  ]

  // Evidence pin, not adapter behaviour: xAI accepted `max_turns` and ran
  // more search rounds than the cap. If a re-recorded fixture breaks this,
  // xAI has started enforcing the field — update the README and DECISIONS.
  it.each(cases)('%s ran more search rounds than max_turns', (name) => {
    const call = fixture[name] as LiveCall & { body: { output_item_types: string[] } }
    expect(call.status).toBe(200)
    const maxTurns = call.request['max_turns'] as number
    const types = call.body.output_item_types
    const rounds = types.filter(
      (type, index) =>
        type === 'web_search_call' && types[index - 1] !== 'web_search_call',
    ).length
    expect(rounds).toBeGreaterThan(maxTurns)
    const details = (call.body['usage'] as Record<string, Record<string, number>>)[
      'server_side_tool_usage_details'
    ]
    expect(details?.['web_search_calls']).toBeGreaterThan(maxTurns)
  })
})

describe('fixture: 34-strict-schema-dialect (live 2026-10-02)', () => {
  interface SchemaCall extends FixtureCall {
    requestSchema: JsonValue
  }
  const fixture = loadFixture<Record<string, SchemaCall>>('34-strict-schema-dialect.json')

  function lastMessageJson(call: SchemaCall): Record<string, unknown> {
    const output = call.body['output'] as Array<{
      type: string
      content?: Array<{ text: string }>
    }>
    const message = output.filter((item) => item.type === 'message').at(-1)
    return JSON.parse(message?.content?.[0]?.text ?? '') as Record<string, unknown>
  }

  it.each(['grok_4_5', 'grok_4_6', 'grok_4_7'])(
    'xAI accepted `nullable: true` on %s and the model could not answer null',
    (model) => {
      const call = fixture[`nullable_keyword_${model}`] as SchemaCall
      expect(call.status).toBe(200)
      const answer = lastMessageJson(call)
      expect(answer['employeeCount']).not.toBeNull()
      expect(answer['foundedYear']).not.toBeNull()
      expect(() => assertXaiOutputJsonSchema(call.requestSchema)).toThrow(
        /properties\.employeeCount/,
      )
    },
  )

  it('a null type union passes the preflight and returns real nulls', () => {
    const call = fixture['null_type_union_grok_4_5'] as SchemaCall
    expect(() => assertXaiOutputJsonSchema(call.requestSchema)).not.toThrow()
    expect(lastMessageJson(call)).toMatchObject({
      employeeCount: null,
      foundedYear: null,
    })
  })

  it('uppercase type names fail at xAI with 400; the preflight rejects them first', () => {
    const call = fixture['uppercase_types_grok_4_5'] as SchemaCall
    expect(call.status).toBe(400)
    expect(JSON.stringify(call.body)).toContain('STRING')
    expect(() => assertXaiOutputJsonSchema(call.requestSchema)).toThrow(/"OBJECT"/)
  })
})
