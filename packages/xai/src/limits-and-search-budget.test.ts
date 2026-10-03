/**
 * R3.1 / R3.3 — xAI descriptor limits, admitted image types, and the
 * observed-after-the-call search budget. No network: fake client only.
 */

import { describe, expect, it } from 'vitest'
import { createClient } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { RecordingSink, fakeXaiResponse, makeFakeXai } from '@gullabs/testing'

import { xaiAdapter } from './adapter.js'
import { grok45ModelDescriptor, xaiModelDescriptors, xaiRegistry } from './models.js'

const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function req(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: {},
    modelDescriptor: grok45ModelDescriptor,
    ...overrides,
  }
}

function clientFor(response = fakeXaiResponse({ text: 'ok' })) {
  const fake = makeFakeXai(response)
  const client = createClient({
    adapters: [xaiAdapter({ client: fake })],
    modelRegistry: xaiRegistry,
    sink: new RecordingSink(),
  })
  return { fake, client }
}

const image = (mimeType: string) => [
  {
    role: 'user' as const,
    parts: [
      { kind: 'text' as const, text: 'look' },
      { kind: 'inline-media' as const, mimeType, data: 'ZmFrZQ==' },
    ],
  },
]

describe('xai descriptor limits (docs read 2026-10-03)', () => {
  it('states the 500,000-token window and, with no documented output limit, the window', () => {
    for (const d of xaiModelDescriptors) {
      expect(d.limits).toEqual({ contextWindow: 500_000, maxOutputTokens: 500_000 })
    }
  })

  it('every config schema caps maxOutputTokens at limits.maxOutputTokens', () => {
    for (const d of xaiModelDescriptors) {
      const cap = d.limits.maxOutputTokens
      expect(d.configSchema.safeParse({ maxOutputTokens: cap }).success).toBe(true)
      expect(d.configSchema.safeParse({ maxOutputTokens: cap + 1 }).success).toBe(false)
    }
  })

  it('the engine rejects an over-cap maxOutputTokens before dispatch', async () => {
    const { fake, client } = clientFor()
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.6',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: { maxOutputTokens: 500_001 },
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('xai admitted input media types', () => {
  it('every model admits exactly image/jpeg and image/png', () => {
    for (const d of xaiModelDescriptors) {
      expect(d.capabilities?.inputMimeTypes).toEqual(['image/jpeg', 'image/png'])
    }
  })

  it('accepts JPEG and PNG and sends them as input_image', async () => {
    for (const mimeType of ['image/jpeg', 'image/png']) {
      const { fake, client } = clientFor()
      await client.generate(
        { provider: 'xai', model: 'grok-4.5', messages: image(mimeType) },
        { auth: { apiKey: 'k' } },
      )
      expect(JSON.stringify(fake.calls[0])).toContain(`data:${mimeType};base64,`)
    }
  })

  it.each(['image/webp', 'image/gif', 'image/jpg', 'application/pdf'])(
    'rejects %s before dispatch with the path and the admitted types',
    async (mimeType) => {
      const { fake, client } = clientFor()
      const err = await client
        .generate(
          { provider: 'xai', model: 'grok-4.5', messages: image(mimeType) },
          { auth: { apiKey: 'k' } },
        )
        .catch((e: unknown) => e)
      expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
      expect((err as Error).message).toContain('messages[0].parts[1]')
      expect((err as Error).message).toContain('image/jpeg, image/png')
      expect(fake.calls).toHaveLength(0)
    },
  )

  it('rejects a file-uri WebP, and a direct adapter call without a descriptor is still checked', async () => {
    const { fake, client } = clientFor()
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'file-uri',
                  uri: 'https://x.test/a.webp',
                  mimeType: 'image/webp',
                },
              ],
            },
          ],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)

    const direct = makeFakeXai(fakeXaiResponse({ text: 'ok' }))
    const run = xaiAdapter({ client: direct }).run(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: image('image/webp'),
        config: {},
      },
      FAKE_CTX,
    )
    await expect(run).rejects.toMatchObject({ kind: 'bad_request' })
    expect(direct.calls).toHaveLength(0)
  })
})

describe('providerOptions.xai.searchBudget', () => {
  function usage(details: Record<string, number>) {
    const response = fakeXaiResponse({
      text: 'ok',
      inputTokens: 10,
      outputTokens: 4,
      usageExtras: { num_server_side_tools_used: 1 },
    })
    response.usage['server_side_tool_usage_details'] = details
    return response
  }
  const run = (response: ReturnType<typeof usage>, xai: Record<string, unknown>) => {
    const client = makeFakeXai(response)
    const promise = xaiAdapter({ client }).run(
      req({ config: { providerOptions: { xai: xai as never } } }),
      FAKE_CTX,
    )
    return { client, promise }
  }

  it('flags web search calls over the budget, keeps the result, and sends nothing to xAI', async () => {
    const { client, promise } = run(usage({ web_search_calls: 5 }), {
      tools: [{ type: 'web_search' }],
      searchBudget: { maxWebSearchCalls: 3 },
    })
    const result = await promise
    expect(result.text).toBe('ok')
    expect(result.usage.details.search_budget_exceeded).toBe(1)
    expect(result.usage.details.web_search_calls).toBe(5)
    expect(result.warnings.map((w) => w.message)).toEqual([
      'xai: search budget exceeded (web_search_calls 5 > maxWebSearchCalls 3); the call is already billed and its result is returned.',
    ])
    expect(JSON.stringify(client.calls[0])).not.toContain('searchBudget')
    expect(JSON.stringify(client.calls[0])).not.toContain('search_budget')
  })

  it('at the budget is not over it', async () => {
    const { promise } = run(usage({ web_search_calls: 3 }), {
      tools: [{ type: 'web_search' }],
      searchBudget: { maxWebSearchCalls: 3 },
    })
    const result = await promise
    expect(result.usage.details).not.toHaveProperty('search_budget_exceeded')
    expect(result.warnings).toEqual([])
  })

  it('sums X posts and users against maxXItems', async () => {
    const over = await run(usage({ x_posts_fetched: 8, x_users_fetched: 3 }), {
      tools: [{ type: 'x_search' }],
      searchBudget: { maxXItems: 10 },
    }).promise
    expect(over.usage.details.search_budget_exceeded).toBe(1)
    expect(over.warnings[0]?.message).toContain('X items 11 > maxXItems 10')

    const within = await run(usage({ x_posts_fetched: 8, x_users_fetched: 2 }), {
      tools: [{ type: 'x_search' }],
      searchBudget: { maxXItems: 10 },
    }).promise
    expect(within.usage.details).not.toHaveProperty('search_budget_exceeded')
  })

  it('checks both lines and names each one that is over', async () => {
    const result = await run(
      usage({ web_search_calls: 4, x_posts_fetched: 9, x_users_fetched: 0 }),
      {
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        searchBudget: { maxWebSearchCalls: 2, maxXItems: 5 },
      },
    ).promise
    expect(result.warnings[0]?.message).toContain(
      'web_search_calls 4 > maxWebSearchCalls 2',
    )
    expect(result.warnings[0]?.message).toContain('X items 9 > maxXItems 5')
  })

  it('a missing counter cannot be compared and is not reported as over', async () => {
    const result = await run(usage({ x_posts_fetched: 1, x_users_fetched: 0 }), {
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      searchBudget: { maxWebSearchCalls: 1 },
    }).promise
    expect(result.usage.details).not.toHaveProperty('search_budget_exceeded')
  })

  it.each([
    [{ maxWebSearchCalls: 0 }, 'maxWebSearchCalls must be an integer >= 1'],
    [{ maxWebSearchCalls: 1.5 }, 'maxWebSearchCalls must be an integer >= 1'],
    [{ maxXItems: '3' }, 'maxXItems must be an integer >= 1'],
    [{}, 'must set maxWebSearchCalls or maxXItems'],
    [{ maxTurns: 2 }, 'unsupported keys [maxTurns]'],
    [[], 'must be an object'],
  ])('rejects the invalid budget %j before dispatch', async (searchBudget, message) => {
    const { client, promise } = run(usage({ web_search_calls: 1 }), {
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      searchBudget,
    })
    await expect(promise).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining(message),
    })
    expect(client.calls).toHaveLength(0)
  })

  it('requires tools, and the tool its ceiling counts', async () => {
    for (const [xai, message] of [
      [{ searchBudget: { maxWebSearchCalls: 1 } }, 'requires a web_search tool'],
      [
        { tools: [{ type: 'x_search' }], searchBudget: { maxWebSearchCalls: 1 } },
        'requires a web_search tool',
      ],
      [
        { tools: [{ type: 'web_search' }], searchBudget: { maxXItems: 1 } },
        'requires an x_search tool',
      ],
    ] as const) {
      const { client, promise } = run(usage({ web_search_calls: 1 }), xai)
      await expect(promise).rejects.toMatchObject({
        kind: 'bad_request',
        message: expect.stringContaining(message),
      })
      expect(client.calls).toHaveLength(0)
    }
  })

  it('is part of the config schema', () => {
    expect(
      grok45ModelDescriptor.configSchema.safeParse({
        providerOptions: {
          xai: {
            tools: [{ type: 'web_search' }],
            searchBudget: { maxWebSearchCalls: 2 },
          },
        },
      }).success,
    ).toBe(true)
    expect(
      grok45ModelDescriptor.configSchema.safeParse({
        providerOptions: { xai: { searchBudget: { maxWebSearchCalls: 0 } } },
      }).success,
    ).toBe(false)
    expect(
      grok45ModelDescriptor.configSchema.safeParse({
        providerOptions: { xai: { searchBudget: { other: 1 } } },
      }).success,
    ).toBe(false)
  })
})
