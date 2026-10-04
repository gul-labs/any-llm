/**
 * Adapter-level surface-stress tests for @gullabs/google.
 *
 * Hammers the geminiAdapter with adversarial inputs via makeFakeGemini.
 * NO real network — all calls go through FakeGeminiClient.
 *
 * Invariants verified:
 *   1. Malformed usageMetadata — GROSS rule always holds after mapping.
 *   2. Blocked responses → LlmError content_filter.
 *   3. Weird finishReason strings → valid FinishReason or 'other'.
 *   4. Thought-only parts → reasoningText present, text absent.
 *   5. Empty / missing parts → adapter does not throw.
 *   6. Non-JSON text with schema → rawStructured absent → outputParsed false.
 *   7. Injected HTTP errors → classified to correct LlmErrorKind.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx, FinishReason } from '@gullabs/core'
import {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
  FakeClock,
  FakeIds,
  RecordingSink,
} from '@gullabs/testing'
import type { GeminiResponseLike, GeminiUsageMetadataLike } from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry } from './models.js'

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed
  return function (): number {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const PRICING = geminiPricingSource()
const TEST_AUTH = { apiKey: 'test-key' }
const MESSAGES = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] },
]

/** Minimal resolved request for direct adapter.run() tests. */
function makeReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: MESSAGES,
    config: { serviceTier: 'flex' },
    modelDescriptor: defaultGeminiRegistry.resolve('google', 'gemini-2.5-pro')!,
    ...overrides,
  }
}

/** Minimal adapter context for direct adapter.run() tests. */
const FAKE_CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

// ---------------------------------------------------------------------------
// INVARIANT 1: Malformed / partial usageMetadata — GROSS rule holds
// ---------------------------------------------------------------------------

describe('adapter-stress: malformed usageMetadata — GROSS rule', () => {
  it('only promptTokenCount present → outputTokens=0, cachedInputTokens absent (30 iterations)', async () => {
    const rand = mulberry32(0x87654321)

    for (let i = 0; i < 30; i++) {
      const promptTokenCount = Math.floor(rand() * 5_000) + 1

      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount },
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      expect(result.usage.inputTokens).toBe(promptTokenCount)
      // candidatesTokenCount missing → 0; thoughtsTokenCount missing → 0
      expect(result.usage.outputTokens).toBe(0)
      expect(result.usage.cachedInputTokens).toBeUndefined()
      expect(result.usage.thinkingTokens).toBeUndefined()

      // GROSS: outputTokens is candidates(0) + thoughts(0) = 0 ✓
      // GROSS: no subset violations since they're absent
    }
  })

  it('only thoughtsTokenCount present → outputTokens = 0 + thoughts (20 iterations)', async () => {
    const rand = mulberry32(0x11223344)

    for (let i = 0; i < 20; i++) {
      const thoughtsTokenCount = Math.floor(rand() * 3_000) + 1

      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [{ text: 'hi', thought: false }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { thoughtsTokenCount },
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      // GROSS rule: outputTokens = candidates(0) + thoughts
      expect(result.usage.outputTokens).toBe(thoughtsTokenCount)
      expect(result.usage.thinkingTokens).toBe(thoughtsTokenCount)
      expect(result.usage.inputTokens).toBe(0)

      // GROSS subset invariant: thinkingTokens ⊆ outputTokens
      expect(result.usage.thinkingTokens).toBeLessThanOrEqual(result.usage.outputTokens)
    }
  })

  it('all usageMetadata fields missing → all token counts default to 0 (15 iterations)', async () => {
    for (let i = 0; i < 15; i++) {
      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
        // usageMetadata entirely absent
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      expect(result.usage.inputTokens).toBe(0)
      expect(result.usage.outputTokens).toBe(0)
      expect(result.usage.cachedInputTokens).toBeUndefined()
      expect(result.usage.thinkingTokens).toBeUndefined()
      expect(result.usage.raw).toBeNull() // no usageMetadata → raw is null
    }
  })

  it('GROSS rule: outputTokens === candidatesTokenCount + thoughtsTokenCount (100 iterations)', async () => {
    const rand = mulberry32(0xcafecafe)

    for (let i = 0; i < 100; i++) {
      const promptTokenCount = Math.floor(rand() * 10_000)
      const candidatesTokenCount = Math.floor(rand() * 5_000)
      const thoughtsTokenCount = rand() > 0.4 ? Math.floor(rand() * 3_000) : undefined
      const cachedContentTokenCount =
        rand() > 0.5 ? Math.floor(rand() * Math.max(1, promptTokenCount)) : undefined

      const usageMetadata: GeminiUsageMetadataLike = {
        ...(promptTokenCount !== undefined ? { promptTokenCount } : {}),
        ...(candidatesTokenCount !== undefined ? { candidatesTokenCount } : {}),
        ...(thoughtsTokenCount !== undefined ? { thoughtsTokenCount } : {}),
        ...(cachedContentTokenCount !== undefined ? { cachedContentTokenCount } : {}),
      }

      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata,
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      const expectedOutput = candidatesTokenCount + (thoughtsTokenCount ?? 0)
      expect(
        result.usage.outputTokens,
        `iter ${i}: outputTokens must equal candidates + thoughts`,
      ).toBe(expectedOutput)

      expect(result.usage.inputTokens).toBe(promptTokenCount)

      if (thoughtsTokenCount !== undefined) {
        expect(result.usage.thinkingTokens).toBe(thoughtsTokenCount)
        // thinking ⊆ output
        expect(result.usage.thinkingTokens).toBeLessThanOrEqual(result.usage.outputTokens)
      } else {
        expect(result.usage.thinkingTokens).toBeUndefined()
      }

      if (cachedContentTokenCount !== undefined) {
        expect(result.usage.cachedInputTokens).toBe(cachedContentTokenCount)
        // cached ⊆ input — note: adapter does NOT enforce this; engine sanitizeUsage does.
        // Here we just check it's passed through from the API response.
      }

      // raw is the full usageMetadata object
      expect(result.usage.raw).not.toBeNull()
    }
  })

  it('huge token count values — mapping never throws (30 iterations)', async () => {
    const HUGE_VALS = [Number.MAX_SAFE_INTEGER, 2 ** 32 - 1, 1_000_000_000, 999_999_999]
    const rand = mulberry32(0x55667788)

    for (let i = 0; i < 30; i++) {
      const pick = () => HUGE_VALS[Math.floor(rand() * HUGE_VALS.length)]!
      const candidatesTokenCount = pick()
      const thoughtsTokenCount = pick()
      const promptTokenCount = pick()

      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [{ text: 'big' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount },
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      // Must not throw
      const result = await adapter.run(makeReq(), FAKE_CTX)

      // GROSS rule still holds at adapter level
      expect(result.usage.outputTokens).toBe(candidatesTokenCount + thoughtsTokenCount)
      expect(result.usage.inputTokens).toBe(promptTokenCount)
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 2: Safety blocks differ from candidate-less provider failures.
// ---------------------------------------------------------------------------

describe('adapter-stress: blocked responses', () => {
  const BLOCK_REASONS = [
    'SAFETY',
    'PROHIBITED_CONTENT',
    'OTHER',
    'RECITATION',
    'BLOCKLIST',
  ]

  it('promptFeedback.blockReason set → LlmError content_filter (all variants)', async () => {
    for (const blockReason of BLOCK_REASONS) {
      const fakeClient = makeFakeGemini(fakeGeminiBlocked({ blockReason }))

      const adapter = geminiAdapter({ client: fakeClient })
      const err = await adapter.run(makeReq(), FAKE_CTX).then(
        () => null,
        (e: unknown) => e,
      )

      expect(err).toBeInstanceOf(LlmError)
      const llmErr = err as LlmError
      expect(llmErr.kind).toBe('content_filter')
      expect(llmErr.retryable).toBe(false)
      expect(llmErr.provider).toBe('google')
    }
  })

  it('no candidates and no blockReason → retryable provider failure', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [],
      // no promptFeedback
    } satisfies GeminiResponseLike)

    const adapter = geminiAdapter({ client: fakeClient })
    await expect(adapter.run(makeReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
      provider: 'google',
    })
  })

  it('candidates absent (undefined) → retryable provider failure', async () => {
    const fakeClient = makeFakeGemini(
      // candidates field entirely absent
      {} as GeminiResponseLike,
    )

    const adapter = geminiAdapter({ client: fakeClient })
    await expect(adapter.run(makeReq(), FAKE_CTX)).rejects.toMatchObject({
      kind: 'server',
    })
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 3: Weird finishReason strings → valid FinishReason or 'other'
// ---------------------------------------------------------------------------

describe('adapter-stress: finishReason mapping', () => {
  const KNOWN_MAPPINGS: Array<[string, FinishReason]> = [
    ['STOP', 'stop'],
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['BLOCKLIST', 'content_filter'],
    ['PROHIBITED_CONTENT', 'content_filter'],
    ['IMAGE_SAFETY', 'content_filter'],
    ['SPII', 'content_filter'],
    ['IMAGE_PROHIBITED_CONTENT', 'content_filter'],
    ['IMAGE_RECITATION', 'content_filter'],
  ]

  const UNKNOWN_REASONS = [
    'MALFORMED_FUNCTION_CALL',
    'LANGUAGE',
    'UNKNOWN_REASON_999',
    'FINISH_REASON_UNSPECIFIED',
    'OTHER', // note: 'OTHER' as SDK string → our 'other'
    '',
    'random-string',
  ]

  it('known finishReasons map to correct FinishReason', async () => {
    for (const [rawReason, expectedMapped] of KNOWN_MAPPINGS) {
      const fakeClient = makeFakeGemini(
        fakeGeminiResponse({
          text: 'ok',
          finishReason: rawReason,
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        }),
      )

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      expect(result.finishReason, `${rawReason} should map to ${expectedMapped}`).toBe(
        expectedMapped,
      )
    }
  })

  it('unknown finishReason strings → mapped to other (20 iterations)', async () => {
    const rand = mulberry32(0xabcdef01)
    const VALID_FINISH_REASONS: FinishReason[] = [
      'stop',
      'length',
      'content_filter',
      'other',
    ]

    for (let i = 0; i < 20; i++) {
      const rawReason = UNKNOWN_REASONS[Math.floor(rand() * UNKNOWN_REASONS.length)]!

      const fakeClient = makeFakeGemini(
        fakeGeminiResponse({
          text: 'ok',
          finishReason: rawReason,
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        }),
      )

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      // Must be one of the valid FinishReason values (or undefined)
      if (result.finishReason !== undefined) {
        expect(
          (VALID_FINISH_REASONS as readonly string[]).includes(result.finishReason),
          `iter ${i}: "${rawReason}" → "${result.finishReason}" must be a valid FinishReason`,
        ).toBe(true)
        // Unknown reasons should map to 'other'
        expect(result.finishReason).toBe('other')
      }
    }
  })

  it('undefined finishReason → finishReason absent on result', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [
        {
          content: { parts: [{ text: 'ok' }] },
          // finishReason absent
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    } satisfies GeminiResponseLike)

    const adapter = geminiAdapter({ client: fakeClient })
    const result = await adapter.run(makeReq(), FAKE_CTX)

    expect(result.finishReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 4: Thought-only parts
// ---------------------------------------------------------------------------

describe('adapter-stress: thought-only parts', () => {
  it('thought-only content → reasoningText present, text absent (15 iterations)', async () => {
    const rand = mulberry32(0x12321232)

    for (let i = 0; i < 15; i++) {
      const thoughtContent = `thought text ${i} ${'x'.repeat(Math.floor(rand() * 20))}`

      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: {
              parts: [
                { text: thoughtContent, thought: true },
                // No non-thought parts
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 5,
        },
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      // reasoningText present (from thought part)
      expect(result.reasoningText, `iter ${i}: reasoningText should be present`).toBe(
        thoughtContent,
      )
      // text absent (no non-thought text parts)
      expect(result.text).toBeUndefined()
    }
  })

  it('mixed thought + text parts → both present', async () => {
    const thoughtText = 'I am thinking...'
    const mainText = 'Final answer'

    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        thoughtText,
        text: mainText,
        promptTokenCount: 20,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
      }),
    )

    const adapter = geminiAdapter({ client: fakeClient })
    const result = await adapter.run(makeReq(), FAKE_CTX)

    expect(result.reasoningText).toBe(thoughtText)
    expect(result.text).toBe(mainText)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 5: Empty / missing parts — adapter does not throw
// ---------------------------------------------------------------------------

describe('adapter-stress: empty parts', () => {
  it('empty parts array → no text, no reasoningText, no throw (10 iterations)', async () => {
    for (let i = 0; i < 10; i++) {
      const fakeClient = makeFakeGemini({
        candidates: [
          {
            content: { parts: [] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
      } satisfies GeminiResponseLike)

      const adapter = geminiAdapter({ client: fakeClient })
      const result = await adapter.run(makeReq(), FAKE_CTX)

      expect(result.text).toBeUndefined()
      expect(result.reasoningText).toBeUndefined()
    }
  })

  it('content.parts absent → no text, no throw', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [
        {
          content: {}, // parts field absent
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
    } satisfies GeminiResponseLike)

    const adapter = geminiAdapter({ client: fakeClient })
    const result = await adapter.run(makeReq(), FAKE_CTX)

    expect(result.text).toBeUndefined()
    expect(result.reasoningText).toBeUndefined()
  })

  it('content absent → no text, no throw', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [
        {
          // content field absent
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
    } satisfies GeminiResponseLike)

    const adapter = geminiAdapter({ client: fakeClient })
    const result = await adapter.run(makeReq(), FAKE_CTX)

    expect(result.text).toBeUndefined()
    expect(result.reasoningText).toBeUndefined()
  })

  it('part with text=undefined → skipped without throw', async () => {
    const fakeClient = makeFakeGemini({
      candidates: [
        {
          content: {
            parts: [
              {}, // text field absent
              { text: 'visible' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    } satisfies GeminiResponseLike)

    const adapter = geminiAdapter({ client: fakeClient })
    const result = await adapter.run(makeReq(), FAKE_CTX)

    expect(result.text).toBe('visible')
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 6: Non-JSON text with schema → outputParsed false
// ---------------------------------------------------------------------------

describe('adapter-stress: non-JSON text + structured output → outputParsed false', () => {
  const BAD_JSON_TEXTS = [
    'not json at all',
    '{ incomplete',
    'undefined',
    '{ "key": }',
    '<xml>nope</xml>',
    'true extra', // valid JSON prefix but trailing garbage
    '', // empty string → JSON.parse('') throws
  ]

  it('non-JSON text with schema → successful call with outputParsed false', async () => {
    const rand = mulberry32(0x55443311)

    for (let i = 0; i < BAD_JSON_TEXTS.length; i++) {
      const badText = BAD_JSON_TEXTS[i]!

      const fakeClient = makeFakeGemini(
        fakeGeminiResponse({
          text: badText,
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          finishReason: 'STOP',
        }),
      )

      const sink = new RecordingSink()
      const client = createClient({
        adapters: [geminiAdapter({ client: fakeClient })],
        pricingSources: { google: PRICING },
        modelRegistry: defaultGeminiRegistry,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: MESSAGES,
          output: { jsonSchema: { type: 'object', additionalProperties: true } },
        },
        { auth: TEST_AUTH },
      )

      const rec = sink.last()!
      expect(
        rec.status,
        `iter ${i} (text="${badText.slice(0, 20)}"): record status must be ok`,
      ).toBe('ok')
      expect(result.output).toBeUndefined()
      expect(result.outputParsed).toBe(false)

      // Unused variable suppression
      void rand
    }
  })

  it('adapter leaves rawStructured undefined when JSON.parse fails', async () => {
    const fakeClient = makeFakeGemini(
      fakeGeminiResponse({
        text: 'not json',
        promptTokenCount: 5,
        candidatesTokenCount: 3,
      }),
    )

    const adapter = geminiAdapter({ client: fakeClient })

    // Request WITH outputJsonSchema — adapter will attempt JSON.parse on text
    const req = makeReq({
      outputJsonSchema: { type: 'object', properties: { answer: { type: 'number' } } },
    })
    const result = await adapter.run(req, FAKE_CTX)

    // rawStructured should be absent (not defined) since JSON.parse failed
    expect(result.rawStructured).toBeUndefined()
    // But text should still be the raw string
    expect(result.text).toBe('not json')
  })

  it('valid JSON text → rawStructured parsed, engine returns output', async () => {
    const rand = mulberry32(0x88776655)
    for (let i = 0; i < 15; i++) {
      const answer = Math.floor(rand() * 10_000)

      const fakeClient = makeFakeGemini(
        fakeGeminiResponse({
          text: JSON.stringify({ answer }),
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          finishReason: 'STOP',
        }),
      )

      const sink = new RecordingSink()
      const client = createClient({
        adapters: [geminiAdapter({ client: fakeClient })],
        pricingSources: { google: PRICING },
        modelRegistry: defaultGeminiRegistry,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: MESSAGES,
          output: { jsonSchema: { type: 'object', additionalProperties: true } },
        },
        { auth: TEST_AUTH },
      )

      expect(result.output).toEqual({ answer })
      expect(result.outputParsed).toBe(true)
      expect(sink.last()!.status).toBe('ok')
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 7: Injected HTTP errors → classified to correct LlmErrorKind
// ---------------------------------------------------------------------------

describe('adapter-stress: injected HTTP errors → correct classification', () => {
  type ErrorMapping = {
    throwValue: unknown
    expectedKind: LlmError['kind']
    expectedRetryable: boolean
  }

  const ERROR_CASES: ErrorMapping[] = [
    {
      throwValue: { status: 401 },
      expectedKind: 'invalid_auth',
      expectedRetryable: false,
    },
    {
      throwValue: { status: 403 },
      expectedKind: 'invalid_auth',
      expectedRetryable: false,
    },
    { throwValue: { status: 408 }, expectedKind: 'timeout', expectedRetryable: true },
    {
      throwValue: { status: 429 },
      expectedKind: 'rate_limited',
      expectedRetryable: true,
    },
    {
      throwValue: { status: 400 },
      expectedKind: 'bad_request',
      expectedRetryable: false,
    },
    { throwValue: { status: 500 }, expectedKind: 'server', expectedRetryable: true },
    { throwValue: { status: 503 }, expectedKind: 'server', expectedRetryable: true },
    { throwValue: { status: 502 }, expectedKind: 'server', expectedRetryable: true },
    // Nested response.status format (some SDK versions use this)
    {
      throwValue: { response: { status: 429 } },
      expectedKind: 'rate_limited',
      expectedRetryable: true,
    },
    {
      throwValue: { response: { status: 401 } },
      expectedKind: 'invalid_auth',
      expectedRetryable: false,
    },
    // LlmError passed through unchanged (already classified)
    {
      throwValue: new LlmError('already classified', { kind: 'server', retryable: true }),
      expectedKind: 'server',
      expectedRetryable: true,
    },
    // Error instance without status → 'unknown'
    {
      throwValue: new Error('plain error'),
      expectedKind: 'unknown',
      expectedRetryable: false,
    },
  ]

  it('each error type is classified to the expected LlmErrorKind', async () => {
    for (const { throwValue, expectedKind, expectedRetryable } of ERROR_CASES) {
      const fakeClient = makeFakeGemini(() => {
        throw throwValue
      })

      const adapter = geminiAdapter({ client: fakeClient })
      const caught = await adapter.run(makeReq(), FAKE_CTX).then(
        () => null,
        (e: unknown) => e,
      )

      expect(
        caught,
        `throwValue=${JSON.stringify(throwValue)}: must throw LlmError`,
      ).toBeInstanceOf(LlmError)
      const err = caught as LlmError
      expect(
        err.kind,
        `throwValue=${JSON.stringify(throwValue)}: kind must be ${expectedKind}`,
      ).toBe(expectedKind)
      expect(
        err.retryable,
        `throwValue=${JSON.stringify(throwValue)}: retryable must be ${String(
          expectedRetryable,
        )}`,
      ).toBe(expectedRetryable)
      // Provider tag must be attached
      expect(err.provider).toBe('google')
    }
  })

  it('429 with retryAfterMs → retryAfterMs forwarded (3 cases)', async () => {
    const RETRY_CASES = [
      { retryAfterMs: 5_000 },
      { retryAfter: 10 }, // treated as seconds → 10_000 ms
    ]

    for (const extra of RETRY_CASES) {
      const fakeClient = makeFakeGemini(() => {
        throw { status: 429, ...extra }
      })

      const adapter = geminiAdapter({ client: fakeClient })
      const caught = await adapter.run(makeReq(), FAKE_CTX).then(
        () => null,
        (e: unknown) => e,
      )

      expect(caught).toBeInstanceOf(LlmError)
      const err = caught as LlmError
      expect(err.kind).toBe('rate_limited')
      expect(err.retryAfterMs).toBeDefined()
      expect(typeof err.retryAfterMs).toBe('number')
    }
  })

  it('error through full engine pipeline → always instanceof LlmError (20 iterations)', async () => {
    const rand = mulberry32(0x44332211)
    const HTTP_STATUSES = [400, 401, 403, 408, 429, 500, 502, 503]

    for (let i = 0; i < 20; i++) {
      const status = HTTP_STATUSES[Math.floor(rand() * HTTP_STATUSES.length)]!

      const fakeClient = makeFakeGemini(() => {
        throw { status }
      })

      const sink = new RecordingSink()
      const client = createClient({
        adapters: [geminiAdapter({ client: fakeClient })],
        pricingSources: { google: PRICING },
        modelRegistry: defaultGeminiRegistry,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const caught = await client
        .generate(
          { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
          { auth: TEST_AUTH },
        )
        .then(
          () => null,
          (e: unknown) => e,
        )

      expect(caught, `iter ${i} (status ${status}): must be LlmError`).toBeInstanceOf(
        LlmError,
      )
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.errorKind).toBeDefined()
    }
  })
})
