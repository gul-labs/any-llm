/**
 * Response and usage mapping, against an injected structural client. The
 * response objects follow the SDK's `Response` typing; their numbers are
 * synthetic.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'

import { openaiAdapter } from './adapter.js'
import type { OpenAiOutputItem, OpenAiResponseShape } from './client.js'
import { CTX, request } from './test-helpers.js'

function run(response: Partial<OpenAiResponseShape>, req = request()) {
  const client = {
    responses: {
      create: (): Promise<OpenAiResponseShape> =>
        Promise.resolve({
          id: 'resp_1',
          model: 'gpt-6.2-sol',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 12,
          },
          service_tier: 'default',
          ...response,
        }),
    },
  }
  return openaiAdapter({ client }).run(req, CTX)
}

const message = (text: string, id = 'msg_1'): OpenAiOutputItem => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})

describe('usage', () => {
  it('maps gross input, cache reads, cache writes with their TTL split and reasoning', async () => {
    const result = await run({
      usage: {
        input_tokens: 1_000,
        input_tokens_details: {
          cached_tokens: 100,
          cache_write_tokens: 300,
          cache_write_tokens_details: { ttl_30m_tokens: 200, ttl_12h_tokens: 100 },
        },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 1_050,
      },
    })
    expect(result.usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 50,
      cachedInputTokens: 100,
      thinkingTokens: 20,
      totalTokens: 1_050,
      details: {
        input: 1_000,
        output: 50,
        cached: 100,
        thinking: 20,
        cache_write: 300,
        cache_write_30m: 200,
        cache_write_12h: 100,
      },
    })
    expect(result.usage.details['usage_incomplete']).toBeUndefined()
    expect(result.usage.details['service_tier_missing']).toBeUndefined()
    expect(result.servedServiceTier).toBe('default')
  })

  it('marks usage without its cache lanes incomplete', async () => {
    const result = await run({
      usage: { input_tokens: 10, output_tokens: 2 },
    })
    expect(result.usage.details['usage_incomplete']).toBe(1)
  })

  it('a terminal response without numeric usage is a non-retryable server error', async () => {
    const err = (await run({ usage: null }).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
  })
})

describe('output', () => {
  it('keeps provider order in the message and returns the full replay state', async () => {
    const output: OpenAiOutputItem[] = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
      message('Checking.', 'msg_0'),
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":1}',
        status: 'completed',
      },
    ]
    const result = await run({ output })
    expect(result.message.parts).toEqual([
      { kind: 'text', text: 'Checking.' },
      { kind: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', args: { q: 1 } },
    ])
    expect(result.finishReason).toBe('tool_calls')
    expect(result.transientProviderState).toEqual({
      openai: {
        model: 'gpt-6.2-sol',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
          ...output,
        ],
      },
    })
  })

  it('a completed call whose arguments are not JSON is a server error carrying the usage', async () => {
    const err = (await run({
      output: [
        {
          type: 'function_call',
          call_id: 'c',
          name: 'n',
          arguments: '{nope',
          status: 'completed',
        },
      ],
    }).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.usage?.inputTokens).toBe(10)
    expect(err.servedServiceTier).toBe('default')
  })

  it('incomplete with content_filter is content_filter; another reason is other with a warning', async () => {
    const filtered = await run({
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [message('par')],
    })
    expect(filtered.finishReason).toBe('content_filter')
    const steered = await run({
      status: 'incomplete',
      incomplete_details: { reason: 'steered' },
      output: [message('par')],
    })
    expect(steered.finishReason).toBe('other')
    expect(steered.warnings.some((w) => w.message.includes('"steered"'))).toBe(true)
  })

  it('warns about an output item type this release does not map, and keeps it in the state', async () => {
    const result = await run({
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        message('a'),
      ],
    })
    expect(result.text).toBe('a')
    expect(result.warnings.some((w) => w.message.includes('web_search_call'))).toBe(true)
    const state = result.transientProviderState as { openai: { input: unknown[] } }
    expect(state.openai.input).toHaveLength(3)
  })

  it('parses structured output from the last message item', async () => {
    const result = await run(
      { output: [message('{"a":1}', 'msg_1'), message('{"a":2}', 'msg_2')] },
      request('gpt-6.2-sol', {
        outputJsonSchema: {
          type: 'object',
          properties: { a: { type: 'integer' } },
          required: ['a'],
          additionalProperties: false,
        },
      }),
    )
    expect(result.rawStructured).toEqual({ a: 2 })
  })

  it('a failed response with an unknown code is unknown and not retryable', async () => {
    const err = (await run({
      status: 'failed',
      error: { code: 'vector_store_timeout', message: 'doc-derived' },
    }).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('unknown')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
  })

  it.each([
    ['server_error', 'server', true],
    ['rate_limit_exceeded', 'rate_limited', true],
    ['bio_policy', 'content_filter', false],
    ['invalid_prompt', 'bad_request', false],
    ['invalid_image_url', 'bad_request', false],
  ] as const)(
    'a failed response with %s before output is %s (retryable %s)',
    async (code, kind, retryable) => {
      const err = (await run({
        status: 'failed',
        error: { code, message: 'doc-derived' },
      }).catch((e: unknown) => e)) as LlmError
      expect(err.kind).toBe(kind)
      expect(err.retryable).toBe(retryable)
    },
  )

  it('warns when a provider output item would be refused in the replay state', async () => {
    const result = await run({
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'a',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x.test',
                  title: 't',
                  start_index: 0,
                  end_index: 1,
                },
              ],
            },
          ],
        },
      ],
    })
    expect(result.text).toBe('a')
    expect(
      result.warnings.some((w) =>
        w.message.includes('output[0].content[0].annotations must be an empty array'),
      ),
    ).toBe(true)
  })
})
