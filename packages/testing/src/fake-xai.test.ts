import { describe, it, expect } from 'vitest'
import { fakeXaiResponse, makeFakeXai, type XaiResponseLike } from './fake-xai.js'

// ---------------------------------------------------------------------------
// fakeXaiResponse
// ---------------------------------------------------------------------------

describe('fakeXaiResponse', () => {
  it('returns a valid XaiResponseLike with defaults (no opts)', () => {
    const r = fakeXaiResponse()
    expect(r.status).toBe('completed')
    expect(r.output).toEqual([])
    expect(r.usage).toBeDefined()
    expect(r.incomplete_details).toBeNull()
  })

  it('builds text output in a message output item', () => {
    const r = fakeXaiResponse({ text: 'Hello world' })
    expect(r.output).toHaveLength(1)
    expect(r.output?.[0]).toEqual({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Hello world' }],
    })
  })

  it('builds a reasoning item before the main message item', () => {
    const r = fakeXaiResponse({ text: 'answer', reasoningText: 'thinking...' })
    expect(r.output).toHaveLength(2)
    expect(r.output?.[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'thinking...' }],
    })
    expect(r.output?.[1]).toMatchObject({ type: 'message' })
  })

  it('places structuredJson in the message output_text part', () => {
    const json = '{"key":"value"}'
    const r = fakeXaiResponse({ structuredJson: json })
    expect(r.output).toHaveLength(1)
    const item = r.output?.[0]
    expect(item?.type).toBe('message')
    if (item?.type === 'message') {
      expect(item.content[0]?.text).toBe(json)
    }
  })

  it('prefers structuredJson over text when both are provided', () => {
    const r = fakeXaiResponse({ text: 'ignored', structuredJson: '{"ok":true}' })
    const item = r.output?.[0]
    if (item?.type === 'message') {
      expect(item.content[0]?.text).toBe('{"ok":true}')
    }
  })

  it('builds function_call items after the message, serializing object arguments', () => {
    const r = fakeXaiResponse({
      text: 'calling',
      functionCalls: [
        { callId: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { callId: 'call_2', name: 'broken', arguments: '{"q":', status: 'incomplete' },
      ],
    })
    expect(r.output.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call',
    ])
    expect(r.output[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
      status: 'completed',
    })
    expect(r.output[2]).toMatchObject({ arguments: '{"q":', status: 'incomplete' })
  })

  it('populates all usage fields', () => {
    const r = fakeXaiResponse({
      inputTokens: 100,
      cachedTokens: 20,
      outputTokens: 50,
      reasoningTokens: 10,
      totalTokens: 150,
    })
    expect(r.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 150,
    })
  })

  it('omits optional usage keys that were not specified, but defaults output_tokens to 0', () => {
    const r = fakeXaiResponse({ inputTokens: 5 })
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 0 })
  })

  it('defaults both input_tokens and output_tokens to 0 when neither is specified', () => {
    const r = fakeXaiResponse()
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('sets status and incomplete_details when incomplete', () => {
    const r = fakeXaiResponse({
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    })
    expect(r.status).toBe('incomplete')
    expect(r.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('defaults id and model', () => {
    const r = fakeXaiResponse()
    expect(r.id).toBe('fake-xai-response-id')
    expect(r.model).toBe('grok-4.5')
  })

  it('accepts overrides for id, model, and promptCacheKey', () => {
    const r = fakeXaiResponse({ id: 'abc', model: 'grok-4.5-mini', promptCacheKey: 'ck' })
    expect(r.id).toBe('abc')
    expect(r.model).toBe('grok-4.5-mini')
    expect(r.prompt_cache_key).toBe('ck')
  })

  it('accepts a serviceTier override as service_tier', () => {
    const r = fakeXaiResponse({ serviceTier: 'priority' })
    expect(r.service_tier).toBe('priority')
  })

  it('omits prompt_cache_key when not specified', () => {
    const r = fakeXaiResponse()
    expect(r).not.toHaveProperty('prompt_cache_key')
  })
})

// ---------------------------------------------------------------------------
// makeFakeXai — single response
// ---------------------------------------------------------------------------

describe('makeFakeXai — single response', () => {
  it('returns the same response on every call', async () => {
    const resp = fakeXaiResponse({ text: 'hello' })
    const client = makeFakeXai(resp)
    const r1 = await client.responses.create({})
    const r2 = await client.responses.create({})
    expect(r1).toBe(resp)
    expect(r2).toBe(resp)
  })

  it('records params in the calls array', async () => {
    const client = makeFakeXai(fakeXaiResponse())
    const params = { model: 'grok-4.5', input: [] }
    await client.responses.create(params)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toBe(params)
  })
})

// ---------------------------------------------------------------------------
// makeFakeXai — array (sequential)
// ---------------------------------------------------------------------------

describe('makeFakeXai — array of responses', () => {
  it('serves responses sequentially', async () => {
    const r1 = fakeXaiResponse({ text: 'first' })
    const r2 = fakeXaiResponse({ text: 'second' })
    const client = makeFakeXai([r1, r2])
    expect(await client.responses.create({})).toBe(r1)
    expect(await client.responses.create({})).toBe(r2)
  })

  it('throws RangeError when the script is exhausted', async () => {
    const client = makeFakeXai([fakeXaiResponse()])
    await client.responses.create({}) // first call OK
    await expect(client.responses.create({})).rejects.toThrow(RangeError)
  })

  it('records all call params in order', async () => {
    const client = makeFakeXai([fakeXaiResponse(), fakeXaiResponse()])
    const p1 = { n: 1 }
    const p2 = { n: 2 }
    await client.responses.create(p1)
    await client.responses.create(p2)
    expect(client.calls).toEqual([p1, p2])
  })
})

// ---------------------------------------------------------------------------
// makeFakeXai — function script
// ---------------------------------------------------------------------------

describe('makeFakeXai — function script', () => {
  it('calls the function with the params and returns its result', async () => {
    let receivedParams: unknown
    const fn = (p: unknown): XaiResponseLike => {
      receivedParams = p
      return fakeXaiResponse({ text: 'dynamic' })
    }
    const client = makeFakeXai(fn)
    const params = { model: 'grok-4.5' }
    const resp = await client.responses.create(params)
    const item = resp.output?.[0]
    expect(item?.type === 'message' ? item.content[0]?.text : undefined).toBe('dynamic')
    expect(receivedParams).toBe(params)
  })

  it('records params even when the function throws', async () => {
    const client = makeFakeXai((_p: unknown): XaiResponseLike => {
      throw { status: 429 }
    })
    const params = { model: 'grok-4.5' }
    await expect(client.responses.create(params)).rejects.toMatchObject({ status: 429 })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toBe(params)
  })

  it('propagates injected plain-object errors (status: 429)', async () => {
    const client = makeFakeXai(() => {
      throw { status: 429 }
    })
    await expect(client.responses.create({})).rejects.toMatchObject({ status: 429 })
  })

  it('propagates injected Error instances', async () => {
    const err = new Error('internal server error')
    const client = makeFakeXai(() => {
      throw err
    })
    await expect(client.responses.create({})).rejects.toThrow('internal server error')
  })

  it('accumulates params from multiple function calls', async () => {
    let callCount = 0
    const client = makeFakeXai((): XaiResponseLike => {
      callCount += 1
      return fakeXaiResponse({ text: `call ${callCount}` })
    })
    await client.responses.create({ n: 1 })
    await client.responses.create({ n: 2 })
    expect(client.calls).toHaveLength(2)
    expect(callCount).toBe(2)
  })
})
