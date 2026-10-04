/**
 * Gemini 3 thought signatures, end to end through the real `@google/genai`
 * request and response transformers. Only `fetch` is stubbed: the SDK builds
 * the HTTP request from what the adapter hands it, so the assertions are on the
 * JSON that would go over the wire.
 *
 * Response shapes (which part carries a signature, parallel-call behaviour,
 * which replays Google rejects) come from the live capture pinned in
 * `__fixtures__/thought-signatures-2026-10-03.json` (ADR-013). Signature values
 * are fake strings of the captured length.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeProviders,
  createClient,
  createModelRegistry,
  LlmError,
} from '@gullabs/core'
import type { JsonValue, LlmResult, Message, ToolDefinition } from '@gullabs/core'
import { runToolLoop } from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { dropMessagesFromSignatureState } from './thought-signatures.js'
import { geminiModelDescriptors } from './models.js'
import { googleProvider } from './provider.js'

// ---------------------------------------------------------------------------
// Pinned capture
// ---------------------------------------------------------------------------

interface CapturedPart {
  kind: string
  signed: boolean
  signatureLength?: number
}
interface CapturedTurn {
  status: number
  parts?: CapturedPart[]
  errorStatus?: string
  errorMessage?: string
}
interface CapturedModel {
  singleCall: {
    turn1: CapturedTurn
    replayAsReturned: CapturedTurn
    replayWithoutSignatures: CapturedTurn
  }
  parallelCalls: {
    turn1: CapturedTurn
    replayAsReturned: CapturedTurn
    replayWithoutSignatures: CapturedTurn
    replayWithoutFirstCallSignature: CapturedTurn
    replayWithDummySignatureOnEveryCall: CapturedTurn
  }
  sequentialTwoSteps: {
    step1: CapturedTurn
    step2: CapturedTurn
    finalWithAllSignatures: CapturedTurn
    finalWithoutStep2Signature: CapturedTurn
    finalWithoutStep1Signature: CapturedTurn
  }
  finalTextPart: {
    signed: boolean
    nextTurnWithSignature: number
    nextTurnWithoutSignature: number
  }
}
const capture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/thought-signatures-2026-10-03.json', import.meta.url),
    ),
    'utf8',
  ),
) as { models: Record<string, CapturedModel> }
const CAPTURED_MODELS = Object.keys(capture.models)

interface IdTurn {
  status: number
}
interface IdCall {
  id: string
  signed: boolean
}
interface IdModel {
  singleCall: {
    turn1Calls: IdCall[]
    replayWithoutIds: IdTurn
    replayWithSynthesizedIds: IdTurn
    replayWithIdOnResponseOnly: IdTurn
  }
  parallelCalls: {
    turn1Calls: IdCall[]
    replayWithoutIds: IdTurn
    replayWithSynthesizedIds: IdTurn
  }
  sequentialSameTool: {
    step1Calls: IdCall[]
    step2Calls: IdCall[]
    finalWithoutIds: IdTurn
    finalWithDuplicateSynthesizedIds: IdTurn
  }
  countTokens: {
    withSignatures: { status: number; totalTokens: number }
    withoutSignatures: { status: number; totalTokens: number }
    withDummySignatures: { status: number; totalTokens: number }
  }
}
const idCapture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/function-call-ids-2026-10-03.json', import.meta.url),
    ),
    'utf8',
  ),
) as { models: Record<string, IdModel> }

// ---------------------------------------------------------------------------
// Wire harness
// ---------------------------------------------------------------------------

interface WireBody {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
}
type WireResponse = { status: number; body: unknown }
/** A queued response that is sent as this exact JSON text (for values JSON.stringify cannot write, like -0). */
const RAW = Symbol('raw')

let wire: { bodies: WireBody[]; urls: string[]; queue: WireResponse[] }

beforeEach(() => {
  wire = { bodies: [], urls: [], queue: [] }
  vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
    wire.urls.push(String(url))
    wire.bodies.push(JSON.parse(init.body ?? '{}') as WireBody)
    const next = wire.queue.shift()
    if (next === undefined) throw new Error('wire stub: no response queued')
    const body = next.body as { [RAW]?: string } | undefined
    return new Response(body?.[RAW] ?? JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const USAGE = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
function respond(parts: Array<Record<string, unknown>>): void {
  wire.queue.push({
    status: 200,
    body: {
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: USAGE,
      modelVersion: 'test-version',
      responseId: 'resp-1',
    },
  })
}
function respondRaw(json: string): void {
  wire.queue.push({ status: 200, body: { [RAW]: json } })
}
const sig = (length: number, tag = 'S'): string =>
  tag.repeat(Math.ceil(length / tag.length)).slice(0, length)
const call = (name: string, args: Record<string, unknown>, signature?: string) => ({
  functionCall: { name, args },
  ...(signature !== undefined ? { thoughtSignature: signature } : {}),
})
const text = (value: string, signature?: string) => ({
  text: value,
  ...(signature !== undefined ? { thoughtSignature: signature } : {}),
})

const MODEL = 'gemini-3.1-flash-lite'
const AUTH = { apiKey: 'test-key' }
const TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
  {
    name: 'get_user_city',
    description: 'Return the city where the user lives.',
    inputJsonSchema: { type: 'object', properties: {} },
  },
]
const USER: Message = { role: 'user', parts: [{ kind: 'text', text: 'Weather?' }] }

const client = createClient({ ...composeProviders([googleProvider()]) })

function generate(
  messages: Message[],
  state?: JsonValue,
  model: string = MODEL,
): Promise<LlmResult> {
  return client.generate(
    {
      provider: 'google',
      model,
      messages,
      tools: TOOLS,
      ...(state !== undefined ? { transientProviderState: state } : {}),
    },
    { auth: AUTH },
  )
}

function toolResults(result: LlmResult, value: JsonValue = { tempC: 18 }): Message {
  return {
    role: 'user',
    parts: (result.toolCalls ?? []).map((c) => ({
      kind: 'tool-result' as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      result: value,
    })),
  }
}

/** Run one turn that replays `history` and report whether dispatch happened. */
async function expectRejectedBeforeDispatch(
  messages: Message[],
  state: JsonValue | undefined,
  pattern: RegExp,
): Promise<LlmError> {
  const before = wire.bodies.length
  let error: unknown
  try {
    await generate(messages, state)
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(LlmError)
  expect(error).toMatchObject({ kind: 'bad_request', retryable: false })
  expect((error as LlmError).message).toMatch(pattern)
  expect(wire.bodies.length).toBe(before)
  return error as LlmError
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// Fixture-driven: every Gemini 3.x model in the capture
// ---------------------------------------------------------------------------

function partsFromCapture(captured: CapturedPart[]): Array<Record<string, unknown>> {
  const cities = ['Paris', 'Tokyo', 'Lima']
  return captured.map((p, i) => {
    const signature = p.signed ? sig(p.signatureLength ?? 8, `${i}`) : undefined
    if (p.kind === 'text') return text(`answer ${i}`, signature)
    const name = p.kind.replace('functionCall:', '')
    return call(
      name,
      name === 'get_weather' ? { city: cities[i] ?? 'Rome' } : {},
      signature,
    )
  })
}

describe.each(CAPTURED_MODELS)('captured behaviour on %s', (model) => {
  const captured = capture.models[model] as CapturedModel

  it('single call: the signature goes back on the same part, and only there', async () => {
    const turn1 = captured.singleCall.turn1.parts as CapturedPart[]
    respond(partsFromCapture(turn1))
    const first = await generate([USER], undefined, model)
    expect(first.continuation).toBe('history')
    expect(first.message.parts.map((p) => p.kind)).toEqual(['tool-call'])
    const entries = (
      first.transientProviderState as {
        google: { signatures: Array<{ partIndex: number }> }
      }
    ).google.signatures
    expect(entries.map((e) => e.partIndex)).toEqual([0])

    respond([text('done')])
    await generate(
      [USER, first.message, toolResults(first)],
      first.transientProviderState,
      model,
    )
    const replayed = wire.bodies[1]?.contents[1]?.parts as Array<Record<string, unknown>>
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.['thoughtSignature']).toBe(
      sig(turn1[0]?.signatureLength ?? 0, '0'),
    )
    expect(replayed[0]?.['functionCall']).toMatchObject({ name: 'get_weather' })
  })

  it('the capture says the replay without signatures was rejected; so is the request, before dispatch', async () => {
    expect(captured.singleCall.replayWithoutSignatures).toMatchObject({
      status: 400,
      errorStatus: 'INVALID_ARGUMENT',
    })
    expect(captured.singleCall.replayWithoutSignatures.errorMessage).toContain(
      'missing a thought_signature',
    )
    respond(partsFromCapture(captured.singleCall.turn1.parts as CapturedPart[]))
    const first = await generate([USER], undefined, model)
    const before = wire.bodies.length
    await expect(
      generate([USER, first.message, toolResults(first)], undefined, model),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(wire.bodies.length).toBe(before)
  })

  it('parallel calls: Google signs only the first call, and the replay needs only that entry', async () => {
    const turn1 = captured.parallelCalls.turn1.parts as CapturedPart[]
    expect(turn1.map((p) => p.signed)).toEqual([true, false, false])
    respond(partsFromCapture(turn1))
    const first = await generate([USER], undefined, model)
    expect(first.toolCalls).toHaveLength(3)
    expect(first.message.parts.map((p) => p.kind)).toEqual([
      'tool-call',
      'tool-call',
      'tool-call',
    ])
    const state = first.transientProviderState as {
      google: { signatures: Array<{ partIndex: number }> }
    }
    expect(state.google.signatures.map((e) => e.partIndex)).toEqual([0])

    respond([text('done')])
    await generate(
      [USER, first.message, toolResults(first)],
      first.transientProviderState,
      model,
    )
    const replayed = wire.bodies[1]?.contents[1]?.parts as Array<Record<string, unknown>>
    expect(replayed.map((p) => p['thoughtSignature'] !== undefined)).toEqual([
      true,
      false,
      false,
    ])
  })

  it('parallel calls: a replay without the first call entry is rejected (as Google rejects it)', async () => {
    expect(captured.parallelCalls.replayWithoutFirstCallSignature.status).toBe(400)
    respond(partsFromCapture(captured.parallelCalls.turn1.parts as CapturedPart[]))
    const first = await generate([USER], undefined, model)
    await expect(
      generate(
        [USER, first.message, toolResults(first)],
        { google: { signatures: [] } },
        model,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('does not offer the dummy signature Google accepted in the capture', async () => {
    expect(captured.parallelCalls.replayWithDummySignatureOnEveryCall.status).toBe(200)
    respond(partsFromCapture(captured.parallelCalls.turn1.parts as CapturedPart[]))
    const first = await generate([USER], undefined, model)
    const before = wire.bodies.length
    await expect(
      generate([USER, first.message, toolResults(first)], undefined, model),
    ).rejects.toThrow(/thought signature/)
    expect(wire.bodies.length).toBe(before)
    expect(JSON.stringify(wire.bodies)).not.toContain('skip_thought_signature_validator')
  })

  it('two sequential steps: each step keeps its own entry, and the final turn replays both', async () => {
    const step1 = captured.sequentialTwoSteps.step1.parts as CapturedPart[]
    const step2 = captured.sequentialTwoSteps.step2.parts as CapturedPart[]
    respond(partsFromCapture(step1))
    const a = await generate([USER], undefined, model)
    expect(a.toolCalls?.map((c) => c.toolName)).toEqual(['get_user_city'])

    const afterStep1 = [USER, a.message, toolResults(a, { city: 'Lisbon' })]
    respond(partsFromCapture(step2))
    const b = await generate(afterStep1, a.transientProviderState, model)
    const stateB = b.transientProviderState as {
      google: { signatures: Array<{ messageIndex: number; partIndex: number }> }
    }
    expect(stateB.google.signatures.map((e) => [e.messageIndex, e.partIndex])).toEqual([
      [1, 0],
      [3, 0],
    ])

    respond([text('It is 18C.')])
    await generate(
      [...afterStep1, b.message, toolResults(b)],
      b.transientProviderState,
      model,
    )
    const last = wire.bodies[2] as WireBody
    expect(last.contents.map((c) => c.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
    ])
    expect(last.contents[1]?.parts[0]?.['thoughtSignature']).toBe(
      sig(step1[0]?.signatureLength ?? 0, '0'),
    )
    expect(last.contents[3]?.parts[0]?.['thoughtSignature']).toBe(
      sig(step2[0]?.signatureLength ?? 0, '0'),
    )
  })

  it('a missing step-1 or step-2 entry is rejected, like the 400s in the capture', async () => {
    expect(captured.sequentialTwoSteps.finalWithoutStep1Signature.status).toBe(400)
    expect(captured.sequentialTwoSteps.finalWithoutStep2Signature.status).toBe(400)
    respond(partsFromCapture(captured.sequentialTwoSteps.step1.parts as CapturedPart[]))
    const a = await generate([USER], undefined, model)
    const afterStep1 = [USER, a.message, toolResults(a, { city: 'Lisbon' })]
    respond(partsFromCapture(captured.sequentialTwoSteps.step2.parts as CapturedPart[]))
    const b = await generate(afterStep1, a.transientProviderState, model)
    const all = (
      b.transientProviderState as {
        google: { signatures: Array<{ messageIndex: number }> }
      }
    ).google.signatures
    const finalHistory = [...afterStep1, b.message, toolResults(b)]
    for (const dropped of [1, 3]) {
      const state = {
        google: { signatures: all.filter((e) => e.messageIndex !== dropped) },
      }
      await expect(generate(finalHistory, state, model)).rejects.toMatchObject({
        kind: 'bad_request',
      })
    }
  })

  it('a signed final text part is carried; an unsigned one is not invented', async () => {
    respond(partsFromCapture(captured.singleCall.turn1.parts as CapturedPart[]))
    const first = await generate([USER], undefined, model)
    const afterCall = [USER, first.message, toolResults(first)]
    const finalParts = [
      captured.finalTextPart.signed ? text('Sunny.', sig(368, 'T')) : text('Sunny.'),
    ]
    respond(finalParts)
    const final = await generate(afterCall, first.transientProviderState, model)
    const entries = (
      final.transientProviderState as {
        google: { signatures: Array<{ messageIndex: number; partIndex: number }> }
      }
    ).google.signatures
    expect(entries.some((e) => e.messageIndex === 3)).toBe(captured.finalTextPart.signed)

    // Next turn: the signature rides back on the text part (when issued), and the
    // capture says Google accepts the turn either way.
    expect(captured.finalTextPart.nextTurnWithSignature).toBe(200)
    expect(captured.finalTextPart.nextTurnWithoutSignature).toBe(200)
    respond([text('ok')])
    await generate(
      [
        ...afterCall,
        final.message,
        { role: 'user', parts: [{ kind: 'text', text: 'Thanks' }] },
      ],
      final.transientProviderState,
      model,
    )
    const replayedText = wire.bodies.at(-1)?.contents[3]?.parts[0] as Record<
      string,
      unknown
    >
    expect(replayedText['text']).toBe('Sunny.')
    expect(replayedText['thoughtSignature'] !== undefined).toBe(
      captured.finalTextPart.signed,
    )

    // Dropping that optional text entry is also accepted.
    respond([text('ok')])
    const withoutText = {
      google: { signatures: entries.filter((e) => e.messageIndex !== 3) },
    }
    await generate(
      [
        ...afterCall,
        final.message,
        { role: 'user', parts: [{ kind: 'text', text: 'Thanks' }] },
      ],
      withoutText,
      model,
    )
    expect(
      wire.bodies.at(-1)?.contents[3]?.parts[0]?.['thoughtSignature'],
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Producing: LlmResult.message and the overlay
// ---------------------------------------------------------------------------

describe('result.message and the signature overlay', () => {
  it('keeps provider order, drops thought parts, and indexes entries over message.parts', async () => {
    respond([
      { text: 'planning', thought: true, thoughtSignature: sig(20, 'th') },
      text('Let me check.', sig(24, 'a')),
      call('get_weather', { city: 'Paris' }, sig(40, 'b')),
      text('and also'),
      call('get_weather', { city: 'Tokyo' }),
    ])
    const result = await generate([USER])
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Let me check.' },
        {
          kind: 'tool-call',
          toolCallId: 'anyllm_call_get_weather_1',
          toolName: 'get_weather',
          args: { city: 'Paris' },
        },
        { kind: 'text', text: 'and also' },
        {
          kind: 'tool-call',
          toolCallId: 'anyllm_call_get_weather_2',
          toolName: 'get_weather',
          args: { city: 'Tokyo' },
        },
      ],
    })
    // Conveniences derived from the same output.
    expect(result.text).toBe('Let me check.and also')
    expect(result.toolCalls?.map((c) => c.toolCallId)).toEqual([
      'anyllm_call_get_weather_1',
      'anyllm_call_get_weather_2',
    ])
    expect(result.finishReason).toBe('tool_calls')
    expect(result.reasoningText).toBe('planning')

    const state = result.transientProviderState as {
      google: { signatures: Array<Record<string, unknown>> }
    }
    expect(
      state.google.signatures.map((e) => [
        e.messageIndex,
        e.partIndex,
        e.model,
        e.signature,
      ]),
    ).toEqual([
      [1, 0, MODEL, sig(24, 'a')],
      [1, 1, MODEL, sig(40, 'b')],
    ])
    for (const entry of state.google.signatures) {
      expect(entry['partSha256']).toMatch(/^[0-9a-f]{64}$/)
    }
    // The signature on the omitted thought part is dropped, with a warning.
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
      /dropped 1 thoughtSignature\(s\)/,
    )
  })

  it('binds entries to the index the host will append the message at', async () => {
    respond([call('get_weather', { city: 'Paris' }, sig(16))])
    const result = await generate([
      { role: 'user', parts: [{ kind: 'text', text: 'earlier' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'earlier answer' }] },
      USER,
    ])
    const state = result.transientProviderState as {
      google: { signatures: Array<{ messageIndex: number }> }
    }
    expect(state.google.signatures[0]?.messageIndex).toBe(3)
  })

  it('warns when the first function call arrives unsigned, and returns no state', async () => {
    respond([call('get_weather', { city: 'Paris' })])
    const result = await generate([USER])
    expect(result.transientProviderState).toBeUndefined()
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
      /first function call .* no thoughtSignature/,
    )
  })

  it('carries earlier entries forward unchanged', async () => {
    respond([call('get_user_city', {}, sig(16, 'x'))])
    const a = await generate([USER])
    respond([text('final answer')])
    const b = await generate(
      [USER, a.message, toolResults(a, { city: 'Lisbon' })],
      a.transientProviderState,
    )
    expect(b.transientProviderState).toEqual(a.transientProviderState)
  })
})

// ---------------------------------------------------------------------------
// Consuming: replay, restart, and every way the history can go stale
// ---------------------------------------------------------------------------

async function signedTurn(): Promise<{
  first: LlmResult
  history: Message[]
  state: JsonValue
}> {
  respond([
    text('Checking.', sig(24, 'a')),
    call('get_weather', { city: 'Paris', units: 'metric' }, sig(40, 'b')),
    call('get_weather', { city: 'Tokyo', units: 'metric' }),
  ])
  const first = await generate([USER])
  return {
    first,
    history: [USER, first.message, toolResults(first)],
    state: first.transientProviderState as JsonValue,
  }
}

type Overlay = { google: { signatures: Array<{ [k: string]: JsonValue }> } }

describe('replaying the overlay', () => {
  it('accepts the unedited history with the returned state', async () => {
    const { history, state } = await signedTurn()
    respond([text('ok')])
    await generate(history, state)
    const parts = wire.bodies.at(-1)?.contents[1]?.parts as Array<Record<string, unknown>>
    expect(parts.map((p) => p['thoughtSignature'])).toEqual([
      sig(24, 'a'),
      sig(40, 'b'),
      undefined,
    ])
  })

  it('restart: history and state rebuilt from JSON text still verify', async () => {
    const { history, state } = await signedTurn()
    respond([text('ok')])
    await generate(clone(history), clone(state))
    expect(wire.bodies.at(-1)?.contents[1]?.parts[1]?.['thoughtSignature']).toBe(
      sig(40, 'b'),
    )
  })

  it('restart: key order in the stored history does not matter (jsonb reorders keys)', async () => {
    const { history, state } = await signedTurn()
    // Rebuild every object with its keys in reverse order, as a database might.
    const reverse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverse)
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([k, v]) => [k, reverse(v)]),
        )
      }
      return value
    }
    respond([text('ok')])
    await generate(reverse(history) as Message[], reverse(state) as JsonValue)
    expect(wire.bodies.at(-1)?.contents[1]?.parts[1]?.['thoughtSignature']).toBe(
      sig(40, 'b'),
    )
  })

  it('drops the signature of edited text instead of rejecting (text signatures are optional)', async () => {
    const { history, state } = await signedTurn()
    const edited = clone(history)
    ;(edited[1]?.parts[0] as { text: string }).text = 'Checking!'
    respond([text('ok')])
    const result = await generate(edited, state)
    const parts = wire.bodies.at(-1)?.contents[1]?.parts as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ text: 'Checking!' })
    expect(parts[1]?.['thoughtSignature']).toBe(sig(40, 'b'))
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
      /dropped 1 stale text signature\(s\).*messages\.1\.parts\.0.*does not match/,
    )
    // The stale entry is not carried forward.
    const carried = (result.transientProviderState as Overlay).google.signatures
    expect(carried.map((e) => [e['messageIndex'], e['partIndex'], e['kind']])).toEqual([
      [1, 1, 'tool-call'],
    ])
  })

  it('a host that trims, joins or rebuilds the final text keeps working', async () => {
    respond([call('get_weather', { city: 'Paris' }, sig(16, 'x'))])
    const first = await generate([USER])
    const afterCall = [USER, first.message, toolResults(first)]
    respond([text('Final answer. ', sig(32, 'T'))])
    const final = await generate(afterCall, first.transientProviderState)
    const stored: Message = {
      role: 'assistant',
      parts: [{ kind: 'text', text: 'Final answer.' }], // .trim()-ed by the host
    }
    respond([text('ok')])
    await generate(
      [...afterCall, stored, { role: 'user', parts: [{ kind: 'text', text: 'Thanks' }] }],
      final.transientProviderState,
    )
    expect(wire.bodies.at(-1)?.contents[3]?.parts[0]).toEqual({ text: 'Final answer.' })
    // The function-call signature still rode back.
    expect(wire.bodies.at(-1)?.contents[1]?.parts[0]?.['thoughtSignature']).toBe(
      sig(16, 'x'),
    )
  })

  it('rejects edited tool arguments', async () => {
    const { history, state } = await signedTurn()
    const edited = clone(history)
    ;(edited[1]?.parts[1] as unknown as { args: { city: string } }).args.city = 'London'
    await expectRejectedBeforeDispatch(edited, state, /partSha256|edited, reordered/)
  })

  it('rejects an edited tool-call id', async () => {
    const { history, state } = await signedTurn()
    const edited = clone(history)
    ;(edited[1]?.parts[1] as { toolCallId: string }).toolCallId = 'renamed'
    ;(edited[2]?.parts[0] as { toolCallId: string }).toolCallId = 'renamed'
    await expectRejectedBeforeDispatch(edited, state, /edited, reordered/)
  })

  it('rejects reordered parts', async () => {
    const { history, state } = await signedTurn()
    const reordered = clone(history)
    const parts = (reordered[1] as Message).parts
    ;[parts[0], parts[1]] = [parts[1] as Message['parts'][number], parts[0] as never]
    await expectRejectedBeforeDispatch(reordered, state, /edited, reordered/)
  })

  it('rejects a removed message', async () => {
    const { history, state } = await signedTurn()
    // Dropping the first user message shifts every index; the entry now points at
    // the tool results (a user message).
    await expectRejectedBeforeDispatch(
      history.slice(1),
      state,
      /assistant message|edited/,
    )
  })

  it('rejects an out-of-range function-call entry; drops an out-of-range text entry', async () => {
    const { history, state } = await signedTurn()
    // signatures[0] is the text entry, signatures[1] the function call.
    const callOutOfMessages = clone(state) as Overlay
    ;(callOutOfMessages.google.signatures[1] as Record<string, unknown>)['messageIndex'] =
      9
    await expectRejectedBeforeDispatch(history, callOutOfMessages, /assistant message/)
    const callOutOfParts = clone(state) as Overlay
    ;(callOutOfParts.google.signatures[1] as Record<string, unknown>)['partIndex'] = 9
    await expectRejectedBeforeDispatch(history, callOutOfParts, /out of range/)

    for (const field of ['messageIndex', 'partIndex']) {
      const textOut = clone(state) as Overlay
      ;(textOut.google.signatures[0] as Record<string, unknown>)[field] = 9
      respond([text('ok')])
      const result = await generate(history, textOut)
      expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
        /dropped 1 stale text signature/,
      )
      expect(
        wire.bodies.at(-1)?.contents[1]?.parts[0]?.['thoughtSignature'],
      ).toBeUndefined()
    }
  })

  it('rejects a duplicate entry', async () => {
    const { history, state } = await signedTurn()
    const duplicated = clone(state) as Overlay
    duplicated.google.signatures.push(clone(duplicated.google.signatures[1]) as never)
    await expectRejectedBeforeDispatch(history, duplicated, /duplicates the entry/)
  })

  it('rejects an entry issued for another model', async () => {
    const { history, state } = await signedTurn()
    respond([text('unused')])
    await expect(generate(history, state, 'gemini-3.1-pro-preview')).rejects.toThrow(
      /not replayed across models/,
    )
    // The same state under the original model is fine.
    respond([text('ok')])
    await generate(history, state)
  })

  it('rejects a tool-call message with no entry, naming the first tool call', async () => {
    const { history } = await signedTurn()
    const error = await expectRejectedBeforeDispatch(
      history,
      undefined,
      /anyllm_call_get_weather_1/,
    )
    expect(error.message).toMatch(/thought signature/)
    expect(error.issues?.[0]?.path).toBe('messages.1.parts.1')
    // An overlay with only the optional text entry is not enough either.
    const { state } = await signedTurn()
    const textOnly = clone(state) as Overlay
    textOnly.google.signatures = textOnly.google.signatures.filter(
      (e) => e['partIndex'] === 0,
    )
    await expectRejectedBeforeDispatch(history, textOnly, /anyllm_call_get_weather_1/)
  })

  it('rejects history produced by another provider (tool calls, no Google state)', async () => {
    await expectRejectedBeforeDispatch(
      [
        USER,
        {
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCallId: 'call_x',
              toolName: 'get_weather',
              args: {},
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              kind: 'tool-result',
              toolCallId: 'call_x',
              toolName: 'get_weather',
              result: 1,
            },
          ],
        },
      ],
      undefined,
      /call_x/,
    )
  })

  it.each([
    ['not an object', 'x', /must be \{ google/],
    ['an array', [], /must be \{ google/],
    ['another provider key', { xai: { model: MODEL, input: [] } }, /another provider/],
    [
      'an extra top-level key',
      { google: { signatures: [] }, extra: 1 },
      /another provider/,
    ],
    ['google without signatures', { google: {} }, /must be an array/],
    [
      'an unknown google key',
      { google: { signatures: [], extra: 1 } },
      /not a known key/,
    ],
    ['signatures not an array', { google: { signatures: {} } }, /must be an array/],
    [
      'an entry that is not an object',
      { google: { signatures: [1] } },
      /must be an object/,
    ],
  ])('rejects malformed state: %s', async (_label, state, pattern) => {
    const { history } = await signedTurn()
    await expectRejectedBeforeDispatch(history, state as JsonValue, pattern)
  })

  it.each([
    ['an unknown entry key', { extra: 1 }, /not a known key/],
    ['a negative messageIndex', { messageIndex: -1 }, /messageIndex/],
    ['a fractional partIndex', { partIndex: 0.5 }, /partIndex/],
    ['an unknown kind', { kind: 'media' }, /kind/],
    ['no kind', { kind: undefined }, /kind/],
    ['an empty model', { model: '' }, /model/],
    ['an uppercase digest', { partSha256: 'A'.repeat(64) }, /partSha256/],
    ['a short digest', { partSha256: 'ab' }, /partSha256/],
    ['an empty signature', { signature: '' }, /signature/],
  ])('rejects a malformed entry: %s', async (_label, patch, pattern) => {
    const { history, state } = await signedTurn()
    const broken = clone(state) as Overlay
    Object.assign(broken.google.signatures[0] as Record<string, unknown>, patch)
    await expectRejectedBeforeDispatch(history, broken, pattern)
  })
})

// ---------------------------------------------------------------------------
// Tool results are always objects on the wire
// ---------------------------------------------------------------------------

describe('functionResponse.response is always an object', () => {
  it.each([
    ['an object', { tempC: 18 }, false, { tempC: 18 }],
    ['a number', 18, false, { output: 18 }],
    ['a string', 'sunny', false, { output: 'sunny' }],
    ['null', null, false, { output: null }],
    ['an array', [1, 2], false, { output: [1, 2] }],
    ['an error result', 'boom', true, { error: 'boom' }],
  ])('wraps %s', async (_label, result, isError, expected) => {
    respond([call('get_weather', { city: 'Paris' }, sig(16))])
    const first = await generate([USER])
    respond([text('ok')])
    await generate(
      [
        USER,
        first.message,
        {
          role: 'user',
          parts: [
            {
              kind: 'tool-result',
              toolCallId: 'anyllm_call_get_weather_1',
              toolName: 'get_weather',
              result: result as JsonValue,
              ...(isError ? { isError: true } : {}),
            },
          ],
        },
      ],
      first.transientProviderState,
    )
    const response = wire.bodies.at(-1)?.contents[2]?.parts[0]?.['functionResponse'] as {
      response: unknown
    }
    expect(response.response).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// Model binding: aliases, other models, models without signatures
// ---------------------------------------------------------------------------

describe('model-bound state', () => {
  const base = geminiModelDescriptors.find((d) => d.model === MODEL) as NonNullable<
    (typeof geminiModelDescriptors)[number]
  >
  const aliasClient = createClient({
    adapters: [geminiAdapter()],
    modelRegistry: createModelRegistry([
      { ...base, aliases: ['gemini-3.1-flash-lite-001'] },
    ]),
  })

  it('a declared alias stays an alias: the state is bound to the string the host sent', async () => {
    const alias = 'gemini-3.1-flash-lite-001'
    respond([call('get_weather', { city: 'Paris' }, sig(16))])
    const turn = (messages: Message[], state?: JsonValue, model = alias) =>
      aliasClient.generate(
        {
          provider: 'google',
          model,
          messages,
          tools: TOOLS,
          ...(state !== undefined ? { transientProviderState: state } : {}),
        },
        { auth: AUTH },
      )
    const first = await turn([USER])
    const state = first.transientProviderState as Overlay
    expect(state.google.signatures[0]?.['model']).toBe(alias)
    expect(wire.bodies).toHaveLength(1)

    // The next turn on the same alias is accepted...
    respond([text('ok')])
    await turn(
      [USER, first.message, toolResults(first)],
      first.transientProviderState,
      alias,
    )
    expect(wire.urls.at(-1)).toContain(`/models/${alias}:generateContent`)
    // ...while the canonical id is a different model string and is rejected.
    await expect(
      turn(
        [USER, first.message, toolResults(first)],
        first.transientProviderState,
        MODEL,
      ),
    ).rejects.toThrow(/not replayed across models/)
  })

  it('Gemini 2.5 needs no signatures: tool-call history replays as before, no state is returned', async () => {
    respond([call('get_weather', { city: 'Paris' }, sig(16))])
    const first = await client.generate(
      { provider: 'google', model: 'gemini-2.5-flash', messages: [USER], tools: TOOLS },
      { auth: AUTH },
    )
    expect(first.continuation).toBe('history')
    expect(first.transientProviderState).toBeUndefined()
    expect(first.message.parts[0]).toMatchObject({ kind: 'tool-call' })
    respond([text('ok')])
    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [USER, first.message, toolResults(first)],
        tools: TOOLS,
      },
      { auth: AUTH },
    )
    expect(
      wire.bodies.at(-1)?.contents[1]?.parts[0]?.['thoughtSignature'],
    ).toBeUndefined()
    // The engine refuses state for a model that does not declare providerState.
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [USER],
          transientProviderState: { google: { signatures: [] } },
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

// ---------------------------------------------------------------------------
// The documented loop
// ---------------------------------------------------------------------------

describe('runToolLoop on a history-continuation provider', () => {
  it('follows result.continuation: appends result.message, resends history, passes the overlay', async () => {
    respond([call('get_user_city', {}, sig(16, 'x'))])
    respond([call('get_weather', { city: 'Lisbon' }, sig(16, 'y'))])
    respond([text('It is 18C in Lisbon.')])
    const outcome = await runToolLoop(
      client,
      { provider: 'google', model: MODEL, messages: [USER], tools: TOOLS },
      {
        get_user_city: () => ({ city: 'Lisbon' }),
        get_weather: (args) => ({ city: (args as { city: string }).city, tempC: 18 }),
      },
      { auth: AUTH },
    )
    expect(outcome.result.text).toBe('It is 18C in Lisbon.')
    expect(outcome.turns).toHaveLength(3)
    expect(outcome.turns.every((t) => t.continuation === 'history')).toBe(true)
    // The last request carried the whole history with both signatures.
    const last = wire.bodies.at(-1) as WireBody
    expect(last.contents.map((c) => c.role)).toEqual([
      'user',
      'model',
      'user',
      'model',
      'user',
    ])
    expect(last.contents[1]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'x'))
    expect(last.contents[3]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'y'))
  })

  it('the state-continuation rule is the wrong one for Google: only new messages are rejected', async () => {
    respond([call('get_weather', { city: 'Paris' }, sig(16))])
    const first = await generate([USER])
    // Sending only the tool results (the xAI rule) loses the model turn: the
    // engine finds no prior tool call in the messages, so nothing is dispatched.
    const error = await expectRejectedBeforeDispatch(
      [toolResults(first)],
      first.transientProviderState as JsonValue,
      /Invalid request messages or tools/,
    )
    expect(error.issues?.[0]?.message).toMatch(/does not match a prior tool-call/)
  })
})

// ---------------------------------------------------------------------------
// Provider output that cannot be hashed never fails a billed call
// ---------------------------------------------------------------------------

const rawResponse = (parts: string): string =>
  `{"candidates":[{"content":{"role":"model","parts":[${parts}]},"finishReason":"STOP"}],` +
  `"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":5,"totalTokenCount":1005},` +
  `"modelVersion":"test-version","responseId":"resp-1"}`

describe('provider output outside the JSON domain', () => {
  it('-0 in arguments: the call succeeds, hashes as 0, and replays after a JSON round trip', async () => {
    respondRaw(
      rawResponse(
        '{"functionCall":{"name":"get_weather","args":{"dx":-0.0,"city":"Paris"}},"thoughtSignature":"SIG-NEG-ZERO"}',
      ),
    )
    const first = await generate([USER])
    expect(first.usage.inputTokens).toBe(1000)
    const args = (first.message.parts[0] as unknown as { args: { dx: number } }).args
    expect(Object.is(args.dx, -0)).toBe(true)
    const state = first.transientProviderState as Overlay
    expect(state.google.signatures).toHaveLength(1)

    // A host that stores history as JSON gets 0 back; the entry still verifies.
    const stored = clone([USER, first.message, toolResults(first)])
    respond([text('ok')])
    await generate(stored, clone(state) as JsonValue)
    expect(wire.bodies.at(-1)?.contents[1]?.parts[0]).toMatchObject({
      thoughtSignature: 'SIG-NEG-ZERO',
      functionCall: { args: { dx: 0, city: 'Paris' } },
    })
  })

  it('a lone surrogate in function-call arguments: the billed result is returned without that entry, with a warning', async () => {
    respondRaw(
      rawResponse(
        '{"functionCall":{"name":"get_weather","args":{"city":"Pa\\ud83dris"}},"thoughtSignature":"SIG-LONE"}',
      ),
    )
    const first = await generate([USER])
    expect(first.usage.inputTokens).toBe(1000)
    expect(first.toolCalls).toHaveLength(1)
    expect(first.transientProviderState).toBeUndefined()
    const warning = first.warnings.map((w) => w.message).join('\n')
    expect(warning).toMatch(/no signature entry for messages\.1\.parts\.0/)
    expect(warning).toMatch(/lone surrogate/)
    expect(warning).toMatch(
      /replaying this function call on the next turn will be rejected/,
    )

    // The next turn's bad_request explains it, before dispatch.
    const error = await expectRejectedBeforeDispatch(
      [USER, first.message, toolResults(first)],
      first.transientProviderState,
      /without its thought signature/,
    )
    expect(error.issues?.[0]?.path).toBe('messages.1.parts.0')
  })

  it('a lone surrogate in a signed text part: returned without the optional entry, and the next turn still works', async () => {
    respond([text('half an emoji \ud83d', sig(24, 'T'))])
    const result = await generate([USER])
    expect(result.text).toBe('half an emoji \ud83d')
    expect(result.transientProviderState).toBeUndefined()
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
      /no signature entry for messages\.1\.parts\.0.*optional/,
    )
    respond([text('ok')])
    await generate(
      [USER, result.message, { role: 'user', parts: [{ kind: 'text', text: 'Thanks' }] }],
      result.transientProviderState,
    )
  })

  it('a lone surrogate in a host-supplied signed part is still rejected', async () => {
    const { history, state } = await signedTurn()
    const edited = clone(history)
    ;(edited[1]?.parts[0] as { text: string }).text = 'Checking \ud83d'
    await expectRejectedBeforeDispatch(edited, state, /lone surrogate/)
  })
})

// ---------------------------------------------------------------------------
// Trimming and rewinding the history
// ---------------------------------------------------------------------------

describe('trimming and rewinding the history', () => {
  /** [U1, A1(call), R1, A2(text), U2, A3(call), R3] with the state that goes with it. */
  async function longConversation(): Promise<{ history: Message[]; state: JsonValue }> {
    respond([call('get_user_city', {}, sig(16, 'x'))])
    const a1 = await generate([USER])
    const h1 = [USER, a1.message, toolResults(a1, { city: 'Lisbon' })]
    respond([text('You live in Lisbon.', sig(24, 'T'))])
    const a2 = await generate(h1, a1.transientProviderState)
    const u2: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: 'Weather there?' }],
    }
    const h2 = [...h1, a2.message, u2]
    respond([call('get_weather', { city: 'Lisbon' }, sig(16, 'y'))])
    const a3 = await generate(h2, a2.transientProviderState)
    return {
      history: [...h2, a3.message, toolResults(a3)],
      state: a3.transientProviderState as JsonValue,
    }
  }

  it('front-trim: removing the oldest turn without touching the state is rejected', async () => {
    const { history, state } = await longConversation()
    await expectRejectedBeforeDispatch(
      history.slice(4),
      state,
      /edited, reordered|assistant message|out of range|dropMessagesFromSignatureState/,
    )
  })

  it('front-trim: dropMessagesFromSignatureState rebases the state and the replay carries the right signature', async () => {
    const { history, state } = await longConversation()
    const trimmed = history.slice(4) // [U2, A3, R3]: the whole first turn is gone
    const rebased = dropMessagesFromSignatureState(state, [0, 1, 2, 3])
    expect(
      (rebased as unknown as Overlay).google.signatures.map((e) => [
        e['messageIndex'],
        e['partIndex'],
      ]),
    ).toEqual([[1, 0]])
    respond([text('18C.')])
    await generate(trimmed, rebased as unknown as JsonValue)
    const wireContents = wire.bodies.at(-1)?.contents as WireBody['contents']
    expect(wireContents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(wireContents[1]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'y'))
  })

  it("compaction: one summary takes the place of the range's first message, as the README says", async () => {
    const { history, state } = await longConversation()
    const summary: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: 'Summary: the user lives in Lisbon.' }],
    }
    const compacted = [summary, ...history.slice(4)] // [S, U2, A3, R3]
    const rebased = dropMessagesFromSignatureState(state, [1, 2, 3])
    respond([text('18C.')])
    await generate(compacted, rebased as unknown as JsonValue)
    const sent = wire.bodies.at(-1)?.contents as WireBody['contents']
    expect(sent.map((c) => c.role)).toEqual(['user', 'user', 'model', 'user'])
    expect(sent[2]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'y'))
  })

  it('rewind: resending an earlier history with the newest state is rejected; the helper makes it work', async () => {
    const { history, state } = await longConversation()
    const rewound = history.slice(0, 5) // drop A3 and R3: back to the user turn
    await expectRejectedBeforeDispatch(rewound, state, /assistant message|out of range/)
    const rebased = dropMessagesFromSignatureState(state, [5, 6])
    respond([text('retry')])
    await generate(rewound, rebased as unknown as JsonValue)
    const sent = wire.bodies.at(-1)?.contents as WireBody['contents']
    expect(sent).toHaveLength(5)
    expect(sent[1]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'x'))
    expect(sent[3]?.parts[0]?.['thoughtSignature']).toBe(sig(24, 'T'))
  })

  it('cutting back to an earlier tool step and regenerating from there', async () => {
    const { history, state } = await longConversation()
    const regenerate = history.slice(0, 3) // [U1, A1, R1]: everything after the first tool step is gone
    const rebased = dropMessagesFromSignatureState(state, [3, 4, 5, 6])
    respond([text('again')])
    await generate(regenerate, rebased as unknown as JsonValue)
    expect(wire.bodies.at(-1)?.contents[1]?.parts[0]?.['thoughtSignature']).toBe(
      sig(16, 'x'),
    )
  })

  it('a stale text entry alone never blocks a request', async () => {
    respond([text('hello', sig(24, 'T'))])
    const first = await generate([USER])
    // The host replaced the assistant message with a different one at the same index.
    respond([text('ok')])
    const result = await generate(
      [
        USER,
        { role: 'assistant', parts: [{ kind: 'text', text: 'something else' }] },
        { role: 'user', parts: [{ kind: 'text', text: 'Thanks' }] },
      ],
      first.transientProviderState,
    )
    expect(result.warnings.map((w) => w.message).join('\n')).toMatch(
      /dropped 1 stale text signature/,
    )
    expect(result.transientProviderState).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tool-call ids: Gemini's are replayed verbatim, the library's are never sent
// ---------------------------------------------------------------------------

describe.each(Object.keys(idCapture.models))('function-call ids on %s', (model) => {
  const captured = idCapture.models[model] as IdModel

  it('the capture: Gemini returns ids, and accepts a replay with them, without them, synthesized, or duplicated', () => {
    for (const c of [
      ...captured.singleCall.turn1Calls,
      ...captured.parallelCalls.turn1Calls,
    ]) {
      expect(c.id).toMatch(/^call_\d+$/)
    }
    expect(captured.parallelCalls.turn1Calls.map((c) => c.signed)).toEqual([
      true,
      false,
      false,
    ])
    for (const turn of [
      captured.singleCall.replayWithoutIds,
      captured.singleCall.replayWithSynthesizedIds,
      captured.singleCall.replayWithIdOnResponseOnly,
      captured.parallelCalls.replayWithoutIds,
      captured.parallelCalls.replayWithSynthesizedIds,
      captured.sequentialSameTool.finalWithoutIds,
      captured.sequentialSameTool.finalWithDuplicateSynthesizedIds,
    ]) {
      expect(turn.status).toBe(200)
    }
  })

  it('ids Gemini returned come back verbatim on functionCall and functionResponse', async () => {
    const calls = captured.parallelCalls.turn1Calls
    respond(
      calls.map((c, i) => ({
        functionCall: { id: c.id, name: 'get_weather', args: { city: `City${i}` } },
        ...(c.signed ? { thoughtSignature: sig(16, 'p') } : {}),
      })),
    )
    const first = await generate([USER], undefined, model)
    expect(first.toolCalls?.map((c) => c.toolCallId)).toEqual(calls.map((c) => c.id))
    respond([text('done')])
    await generate(
      [USER, first.message, toolResults(first)],
      first.transientProviderState,
      model,
    )
    const sent = wire.bodies.at(-1)?.contents as WireBody['contents']
    const ids = (index: number, key: string) =>
      sent[index]?.parts.map((p) => (p[key] as { id?: string } | undefined)?.id)
    expect(ids(1, 'functionCall')).toEqual(calls.map((c) => c.id))
    expect(ids(2, 'functionResponse')).toEqual(calls.map((c) => c.id))
  })

  it('when Gemini returns no id the library synthesizes one but never sends it, and ids stay unique across turns', async () => {
    respond([call('get_weather', { city: 'Paris' }, sig(16, 'a'))])
    const a = await generate([USER], undefined, model)
    expect(a.toolCalls?.[0]?.toolCallId).toBe('anyllm_call_get_weather_1')
    const h1 = [USER, a.message, toolResults(a)]

    // The same tool again on the next step: a different id, so the history never
    // holds two calls that share one.
    respond([call('get_weather', { city: 'Tokyo' }, sig(16, 'b'))])
    const b = await generate(h1, a.transientProviderState, model)
    expect(b.toolCalls?.[0]?.toolCallId).toBe('anyllm_call_get_weather_2')
    const sentSecond = wire.bodies.at(-1)?.contents as WireBody['contents']
    expect(JSON.stringify(sentSecond)).not.toContain('anyllm_call_')
    expect(JSON.stringify(sentSecond)).not.toContain('"id"')

    respond([text('done')])
    await generate([...h1, b.message, toolResults(b)], b.transientProviderState, model)
    const sentLast = wire.bodies.at(-1)?.contents as WireBody['contents']
    expect(JSON.stringify(sentLast)).not.toContain('"id"')
    expect(sentLast[1]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'a'))
    expect(sentLast[3]?.parts[0]?.['thoughtSignature']).toBe(sig(16, 'b'))
  })

  it('the part hash still detects an edited name, argument or order with synthesized ids', async () => {
    respond([
      call('get_weather', { city: 'Paris' }, sig(16, 'a')),
      call('get_weather', { city: 'Tokyo' }),
    ])
    const first = await generate([USER], undefined, model)
    const history = [USER, first.message, toolResults(first)]
    const state = first.transientProviderState as JsonValue

    const renamed = clone(history)
    ;(renamed[1]?.parts[0] as { toolName: string }).toolName = 'get_user_city'
    ;(renamed[2]?.parts[0] as { toolName: string }).toolName = 'get_user_city'
    await expectRejectedBeforeDispatch(renamed, state, /edited, reordered/)

    const edited = clone(history)
    ;(edited[1]?.parts[0] as unknown as { args: { city: string } }).args.city = 'Rome'
    await expectRejectedBeforeDispatch(edited, state, /edited, reordered/)

    const swapped = clone(history)
    const parts = (swapped[1] as Message).parts
    ;[parts[0], parts[1]] = [parts[1] as Message['parts'][number], parts[0] as never]
    await expectRejectedBeforeDispatch(swapped, state, /edited, reordered/)
  })

  it('countTokens: the capture says the endpoint takes function calls without signatures and counts the same', () => {
    const { withSignatures, withoutSignatures, withDummySignatures } =
      captured.countTokens
    expect([
      withSignatures.status,
      withoutSignatures.status,
      withDummySignatures.status,
    ]).toEqual([200, 200, 200])
    expect(withoutSignatures.totalTokens).toBe(withSignatures.totalTokens)
    expect(withDummySignatures.totalTokens).toBe(withSignatures.totalTokens)
  })
})

// ---------------------------------------------------------------------------
// A response with nothing representable
// ---------------------------------------------------------------------------

describe('a thought-only response', () => {
  it('has an empty message.parts, and that message is not accepted back into history', async () => {
    respond([{ text: 'pondering', thought: true, thoughtSignature: sig(20, 'th') }])
    const result = await generate([USER])
    expect(result.message).toEqual({ role: 'assistant', parts: [] })
    expect(result.text).toBeUndefined()
    expect(result.toolCalls).toBeUndefined()
    expect(result.transientProviderState).toBeUndefined()

    const before = wire.bodies.length
    const error = await generate(
      [USER, result.message, { role: 'user', parts: [{ kind: 'text', text: 'again' }] }],
      result.transientProviderState,
    ).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'bad_request' })
    expect((error as LlmError).issues?.[0]?.path).toBe('messages.1.parts')
    expect(wire.bodies.length).toBe(before)
    expect(JSON.stringify(wire.bodies)).not.toContain('"parts":[]')
  })

  it('a completely empty candidate is the same: message.parts is empty', async () => {
    respond([])
    const result = await generate([USER])
    expect(result.message).toEqual({ role: 'assistant', parts: [] })
  })
})
