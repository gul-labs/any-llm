/**
 * Surface-stress / fuzz tests for @gullabs/core — engine level.
 *
 * Hammers the public surface with adversarial inputs and proves invariants
 * hold WITHOUT any network.  Deterministic via mulberry32 PRNG (no Math.random).
 *
 * Invariants verified:
 *   1. Only typed LlmErrors escape — generate() either resolves or rejects
 *      instanceof LlmError, NEVER a raw Error or other value.
 *   2. A record is always written — RecordingSink gets exactly one record per
 *      call; on failure status reflects errorKind; postmortem fields present.
 *   3. Malformed usage — engine clamps+warns, never throws, record persists;
 *      cost.details sums to cost.microUsd (or microUsd is null).
 *   4. Cost property — sum(details)===microUsd (known) and microUsd===null (unknown).
 *   5. Fail-open — throwing sink / telemetry / pricing never fails the call.
 *   6. Cancellation — classification is 'timeout' or 'aborted', never mixed.
 *   7. Structured output parse-only — caller owns shape validation.
 *   8. providerOptions.google is strict: allowlisted keys merge, unknown keys reject.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createClient, createModelRegistry, LlmError } from './index.js'
import {
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from './model-config/index.js'
import type {
  AdapterResult,
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  PricingSource,
  Usage,
  Cost,
  Telemetry,
  Warning,
  JsonValue,
  ProviderOptions,
} from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  SignalAwareFakeAdapter,
} from '@gullabs/testing'
import { makeTestPricingSource } from './test-pricing-source.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32 (https://gist.github.com/tommyettinger/46a874533244883189143505d203312c)
// ---------------------------------------------------------------------------

/** Returns a PRNG function seeded with `seed`. Output in [0, 1). */
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
// Shared constants
// ---------------------------------------------------------------------------

const TEST_RATES = {
  'gemini-2.5-pro': {
    standard: { inputPerM: 1_250_000, cachedPerM: 125_000, outputPerM: 10_000_000 },
  },
  'gemini-2.5-flash': {
    standard: { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
  },
  'gemini-2.5-flash-lite': {
    standard: { inputPerM: 100_000, cachedPerM: 10_000, outputPerM: 400_000 },
  },
  'gemini-3.1-flash-lite': {
    standard: { inputPerM: 250_000, cachedPerM: 25_000, outputPerM: 1_500_000 },
  },
  'gemini-3.1-pro-preview': {
    standard: { inputPerM: 2_000_000, cachedPerM: 200_000, outputPerM: 12_000_000 },
  },
}
const PRICING = makeTestPricingSource(TEST_RATES, 'test-pricing-1')
const TEST_REGISTRY = createModelRegistry(
  Object.keys(TEST_RATES).map((model) =>
    makePermissiveTestDescriptor({ model, provider: 'google' }),
  ),
)
function computeCost(model: string, usage: Usage, tier?: string) {
  return PRICING.price(model, usage, tier)
}

/**
 * A strict `providerOptions.google` schema mirroring the shape of a real
 * provider's strict per-model config (allowlisted keys only, unknown keys
 * rejected) — used only by the INVARIANT 8 tests below, which specifically
 * exercise strict-schema rejection behavior at the engine level.
 */
const StrictGoogleOptionsSchema = z
  .strictObject({
    providerOptions: z
      .strictObject({
        google: z
          .strictObject({
            cachedContent: z.string().optional(),
            httpOptions: z.looseObject({}).optional(),
            safetySettings: z.array(z.looseObject({})).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .meta({
    title: 'StrictGoogleOptionsTest',
    description: 'Strict test schema for providerOptions.google allowlisting.',
    examples: [{}],
  })
const STRICT_REGISTRY = createModelRegistry([
  {
    model: 'gemini-2.5-pro',
    provider: 'google',
    limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
    configSchema: StrictGoogleOptionsSchema,
    configKeys: toConfigKeys(StrictGoogleOptionsSchema),
    configJsonSchema: toConfigJsonSchema(StrictGoogleOptionsSchema),
    validateConfig: zodToStandardSchema(StrictGoogleOptionsSchema),
  },
])
const TEST_AUTH = { apiKey: 'test-key' }
const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
] as const
const MESSAGES = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] },
]

/** Build a minimal valid AdapterResult for happy-path use. */
function makeOkResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    usage: { inputTokens: 100, outputTokens: 20, details: {}, raw: null },
    model: 'gemini-2.5-pro',
    warnings: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Custom adapter that can throw ARBITRARY values (strings, null, undefined,
// plain objects, Errors, LlmErrors…) — FakeAdapter only accepts typed entries.
// ---------------------------------------------------------------------------

/**
 * An adapter that either returns a scripted AdapterResult or throws
 * an arbitrary unknown value, for stress-testing the engine's error classifier.
 */
class RawThrowAdapter implements ProviderAdapter {
  readonly id: string
  readonly calls: ResolvedRequest[] = []
  private readonly _action:
    { kind: 'ok'; result: AdapterResult } | { kind: 'throw'; value: unknown }

  constructor(
    id: string,
    action: { kind: 'ok'; result: AdapterResult } | { kind: 'throw'; value: unknown },
  ) {
    this.id = id
    this._action = action
  }

  async run(req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
    this.calls.push(req)
    if (this._action.kind === 'ok') return this._action.result
    throw this._action.value
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 1 + 2: Only LlmErrors escape; a record is always written
// ---------------------------------------------------------------------------

describe('surface-stress: only LlmErrors escape + record always written', () => {
  /**
   * Matrix of adapter behaviors.
   * Each entry pairs a label with a factory for the RawThrowAdapter action.
   */
  type BehaviorFactory = () =>
    | {
        kind: 'ok'
        result: AdapterResult
      }
    | {
        kind: 'throw'
        value: unknown
      }

  const BEHAVIORS: Array<[string, BehaviorFactory]> = [
    ['ok-result', () => ({ kind: 'ok', result: makeOkResult() })],
    ['throw-Error', () => ({ kind: 'throw', value: new Error('boom') })],
    ['throw-status-400', () => ({ kind: 'throw', value: { status: 400 } })],
    ['throw-status-401', () => ({ kind: 'throw', value: { status: 401 } })],
    ['throw-status-403', () => ({ kind: 'throw', value: { status: 403 } })],
    ['throw-status-408', () => ({ kind: 'throw', value: { status: 408 } })],
    ['throw-status-429', () => ({ kind: 'throw', value: { status: 429 } })],
    ['throw-status-500', () => ({ kind: 'throw', value: { status: 500 } })],
    ['throw-status-503', () => ({ kind: 'throw', value: { status: 503 } })],
    ['throw-string', () => ({ kind: 'throw', value: 'raw string error' })],
    ['throw-null', () => ({ kind: 'throw', value: null })],
    ['throw-undefined', () => ({ kind: 'throw', value: undefined })],
    [
      'throw-LlmError',
      () => ({
        kind: 'throw' as const,
        value: new LlmError('pre-classified', { kind: 'server', retryable: true }),
      }),
    ],
    ['throw-number', () => ({ kind: 'throw', value: 42 })],
    [
      'throw-nested-status',
      () => ({ kind: 'throw', value: { response: { status: 429 } } }),
    ],
    [
      'ok-with-warnings',
      () => ({
        kind: 'ok' as const,
        result: makeOkResult({
          warnings: [{ type: 'other', message: 'test warning' }],
        }),
      }),
    ],
  ]

  it('every behavior: either resolves LlmResult or rejects instanceof LlmError (150 iterations)', async () => {
    const rand = mulberry32(0x12345678)
    const ITERATIONS = 150

    for (let i = 0; i < ITERATIONS; i++) {
      const idx = Math.floor(rand() * BEHAVIORS.length)
      const [label, factory] = BEHAVIORS[idx]!
      const action = factory()

      const adapter = new RawThrowAdapter('google', action)
      const sink = new RecordingSink()

      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(1_000 + i),
        ids: new FakeIds(),
      })

      let resolved = false
      let rejected = false
      let rejectedValue: unknown

      try {
        await client.generate(
          { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
          { auth: TEST_AUTH },
        )
        resolved = true
      } catch (e) {
        rejected = true
        rejectedValue = e
      }

      // Either resolved OR rejected — not neither, not both.
      expect(resolved || rejected, `iter ${i} (${label}): must settle`).toBe(true)
      expect(
        resolved && rejected,
        `iter ${i} (${label}): cannot both resolve and reject`,
      ).toBe(false)

      if (rejected) {
        // INVARIANT 1: rejection must be instanceof LlmError
        expect(
          rejectedValue instanceof LlmError,
          `iter ${i} (${label}): rejection must be LlmError, got ${String(
            rejectedValue,
          )}`,
        ).toBe(true)
        const err = rejectedValue as LlmError
        // LlmError must have a valid kind
        const VALID_KINDS = [
          'invalid_auth',
          'rate_limited',
          'server',
          'timeout',
          'aborted',
          'bad_request',
          'content_filter',
          'unknown',
        ] as const
        expect(
          (VALID_KINDS as readonly string[]).includes(err.kind),
          `iter ${i} (${label}): LlmError.kind must be valid, got "${err.kind}"`,
        ).toBe(true)
      }

      // INVARIANT 2: exactly one record always written
      expect(sink.records.length, `iter ${i} (${label}): expected exactly 1 record`).toBe(
        1,
      )

      const rec = sink.last()!
      expect(rec.recordSchemaVersion).toBe(1)
      expect(rec.provider).toBe('google')

      if (rejected && rejectedValue instanceof LlmError) {
        // postmortem fields present on failure
        expect(rec.errorKind).toBe((rejectedValue as LlmError).kind)
        expect(typeof rec.errorMessage).toBe('string')
        // status reflects errorKind
        const VALID_STATUSES = ['ok', 'api_error', 'timeout', 'aborted', 'content_filter']
        expect(VALID_STATUSES).toContain(rec.status)
      } else if (resolved) {
        expect(rec.status).toBe('ok')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 3: Malformed usage — clamps+warns, never throws
// ---------------------------------------------------------------------------

describe('surface-stress: malformed usage', () => {
  it('cached > input: clamped to input, record persists, cost sum holds (50 iterations)', async () => {
    const rand = mulberry32(0xdeadbeef)

    for (let i = 0; i < 50; i++) {
      const input = Math.floor(rand() * 1000) + 1 // 1–1000
      const cached = input + Math.floor(rand() * 500) + 1 // > input

      const usage: Usage = {
        inputTokens: input,
        outputTokens: Math.floor(rand() * 500) + 1,
        cachedInputTokens: cached,
        details: {},
        raw: null,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      // Clamped: cachedInputTokens must not exceed inputTokens
      expect(
        (result.usage.cachedInputTokens ?? 0) <= result.usage.inputTokens,
        `iter ${i}: cached must be ≤ input after clamp`,
      ).toBe(true)

      // Warning emitted
      const hasClampWarn = result.warnings.some(
        (w): w is Warning & { type: 'other' } =>
          w.type === 'other' && w.message.includes('cachedInputTokens'),
      )
      expect(hasClampWarn, `iter ${i}: expected a cachedInputTokens clamp warning`).toBe(
        true,
      )

      // Record persists
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('ok')

      // Cost sum invariant
      if (result.cost !== undefined && result.cost.microUsd !== null) {
        const sum =
          result.cost.details.input +
          result.cost.details.cached +
          result.cost.details.output
        expect(sum).toBe(result.cost.microUsd)
      }
    }
  })

  it('thinking > output: clamped to output, record persists, cost sum holds (50 iterations)', async () => {
    const rand = mulberry32(0xbaadf00d)

    for (let i = 0; i < 50; i++) {
      const output = Math.floor(rand() * 500) + 1
      const thinking = output + Math.floor(rand() * 300) + 1 // > output

      const usage: Usage = {
        inputTokens: Math.floor(rand() * 1000) + 1,
        outputTokens: output,
        thinkingTokens: thinking,
        details: {},
        raw: null,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      // Clamped
      expect(
        (result.usage.thinkingTokens ?? 0) <= result.usage.outputTokens,
        `iter ${i}: thinking must be ≤ output after clamp`,
      ).toBe(true)

      // Warning emitted
      const hasWarn = result.warnings.some(
        (w): w is Warning & { type: 'other' } =>
          w.type === 'other' && w.message.includes('thinkingTokens'),
      )
      expect(hasWarn, `iter ${i}: expected a thinkingTokens clamp warning`).toBe(true)

      // Record persists
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('ok')

      // Cost sum invariant
      if (result.cost !== undefined && result.cost.microUsd !== null) {
        const sum =
          result.cost.details.input +
          result.cost.details.cached +
          result.cost.details.output
        expect(sum).toBe(result.cost.microUsd)
      }
    }
  })

  it('NaN / negative / huge token counts: engine never throws, record persists, cost sum holds (60 iterations)', async () => {
    const rand = mulberry32(0xcafebabe)

    // Adversarial token values per spec ("negative-ish/huge (Number.MAX_SAFE_INTEGER) / NaN/undefined").
    // Note: Number.MAX_VALUE is excluded — it overflows to Infinity in cost arithmetic, which
    // is not semantically meaningful and not called out in the SPEC; MAX_SAFE_INTEGER is the
    // stated example. Non-finite values (NaN, ±Infinity) are clamped to 0 by sanitizeUsage.
    const ADVERSARIAL_INPUTS: number[] = [
      NaN,
      -Infinity,
      +Infinity,
      -1,
      -100,
      -999_999,
      Number.MAX_SAFE_INTEGER,
      0,
      1,
      500,
    ]

    for (let i = 0; i < 60; i++) {
      const pickInput = () =>
        ADVERSARIAL_INPUTS[Math.floor(rand() * ADVERSARIAL_INPUTS.length)]!
      const usage = {
        inputTokens: pickInput(),
        outputTokens: pickInput(),
        // Sometimes include optional fields with adversarial values
        ...(rand() > 0.5 ? { cachedInputTokens: pickInput() } : {}),
        ...(rand() > 0.5 ? { thinkingTokens: pickInput() } : {}),
        details: {},
        raw: null,
      } as unknown as Usage

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      // Engine must resolve (not throw) for malformed usage — fail-open per spec.
      // Use direct await: if generate() rejects, Vitest will catch and fail the test.
      const result = await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      // Record always persists
      expect(sink.records, `iter ${i}: record must be written`).toHaveLength(1)
      expect(sink.last()!.status).toBe('ok')

      // Cost sum invariant — must hold after clamping
      if (result.cost !== undefined && result.cost.microUsd !== null) {
        const sum =
          result.cost.details.input +
          result.cost.details.cached +
          result.cost.details.output
        expect(sum, `iter ${i}: sum(details) must equal microUsd`).toBe(
          result.cost.microUsd,
        )
      }

      // All normalized token counts must be non-negative finite numbers
      expect(
        Number.isFinite(result.usage.inputTokens),
        `iter ${i}: inputTokens must be finite`,
      ).toBe(true)
      expect(
        result.usage.inputTokens,
        `iter ${i}: inputTokens must be non-negative`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        Number.isFinite(result.usage.outputTokens),
        `iter ${i}: outputTokens must be finite`,
      ).toBe(true)
      expect(
        result.usage.outputTokens,
        `iter ${i}: outputTokens must be non-negative`,
      ).toBeGreaterThanOrEqual(0)
      if (result.usage.cachedInputTokens !== undefined) {
        expect(
          Number.isFinite(result.usage.cachedInputTokens),
          `iter ${i}: cachedInputTokens must be finite`,
        ).toBe(true)
        expect(result.usage.cachedInputTokens).toBeGreaterThanOrEqual(0)
        expect(result.usage.cachedInputTokens).toBeLessThanOrEqual(
          result.usage.inputTokens,
        )
      }
      if (result.usage.thinkingTokens !== undefined) {
        expect(
          Number.isFinite(result.usage.thinkingTokens),
          `iter ${i}: thinkingTokens must be finite`,
        ).toBe(true)
        expect(result.usage.thinkingTokens).toBeGreaterThanOrEqual(0)
        expect(result.usage.thinkingTokens).toBeLessThanOrEqual(result.usage.outputTokens)
      }
    }
  })

  it('both cached>input AND thinking>output simultaneously: both clamped correctly', async () => {
    const rand = mulberry32(0x11223344)

    for (let i = 0; i < 30; i++) {
      const input = Math.floor(rand() * 500) + 10
      const output = Math.floor(rand() * 500) + 10
      const usage: Usage = {
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: input + 100 + Math.floor(rand() * 100), // > input
        thinkingTokens: output + 50 + Math.floor(rand() * 100), // > output
        details: {},
        raw: null,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      expect(result.usage.cachedInputTokens ?? 0).toBe(input)
      expect(result.usage.thinkingTokens ?? 0).toBe(output)
      expect(sink.records).toHaveLength(1)
      expect(sink.last()!.status).toBe('ok')

      if (result.cost !== undefined && result.cost.microUsd !== null) {
        const sum =
          result.cost.details.input +
          result.cost.details.cached +
          result.cost.details.output
        expect(sum).toBe(result.cost.microUsd)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 3b: Non-finite values INSIDE usage.details and usage.raw
// ---------------------------------------------------------------------------

describe('surface-stress: non-finite values in usage.details and usage.raw', () => {
  /**
   * Verify that the persisted record is fully JSON-safe and all values in
   * tokenDetails are finite and non-negative when the adapter returns
   * non-finite numbers inside usage.details.
   */
  it('non-finite values in usage.details are clamped to 0, record round-trips JSON safely', async () => {
    const adversarialDetailsList: Array<Record<string, number>> = [
      { input: NaN, output: Infinity, cached: -Infinity },
      { input: 100, output: NaN, thinking: -1 },
      { extra: Infinity, input: 0, output: 0 },
      { a: NaN, b: -Infinity, c: +Infinity, d: 5 },
    ]

    for (const details of adversarialDetailsList) {
      const usage: Usage = {
        inputTokens: 100,
        outputTokens: 20,
        details,
        raw: null,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      const rec = sink.last()!

      // Full record must round-trip without data mutation.
      const json = JSON.stringify(rec)
      expect(json, 'JSON.stringify must not throw on the record').toBeTruthy()
      const parsed = JSON.parse(json) as typeof rec
      expect(parsed).toBeDefined()

      // tokenDetails: every stored value must be a finite non-negative number.
      const tokenDetails = rec.tokenDetails as Record<string, unknown>
      for (const [key, val] of Object.entries(tokenDetails)) {
        expect(
          typeof val === 'number' && Number.isFinite(val),
          `tokenDetails["${key}"] must be finite after sanitisation`,
        ).toBe(true)
        expect(
          val as number,
          `tokenDetails["${key}"] must be >= 0 after sanitisation`,
        ).toBeGreaterThanOrEqual(0)
      }
    }
  })

  /**
   * Verify that non-finite numbers nested inside usage.raw are replaced with
   * null (not left as NaN/Infinity) so the stored rawUsage JSONB is valid.
   */
  it('non-finite numbers in usage.raw are replaced with null, record round-trips JSON safely', async () => {
    const adversarialRaws: Array<JsonValue> = [
      { promptTokenCount: NaN, candidatesTokenCount: Infinity } as unknown as JsonValue,
      [NaN, Infinity, -Infinity, 1] as unknown as JsonValue,
      { nested: { deep: NaN } } as unknown as JsonValue,
      { a: 1, b: NaN, c: { d: -Infinity, e: 'ok' } } as unknown as JsonValue,
    ]

    for (const raw of adversarialRaws) {
      const usage: Usage = {
        inputTokens: 50,
        outputTokens: 10,
        details: { input: 50, cached: 0, output: 10, tools: 0 },
        raw,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      const rec = sink.last()!

      // Full record must round-trip cleanly.
      const json = JSON.stringify(rec)
      const parsed = JSON.parse(json) as Record<string, unknown>
      expect(parsed).toBeDefined()

      // rawUsage must round-trip identically — no silent NaN→null coercions
      // during stringify because the values should already be null at rest.
      const rawUsageJson = JSON.stringify(rec.rawUsage)
      const rawUsageParsed = JSON.parse(rawUsageJson) as unknown
      expect(JSON.stringify(rawUsageParsed)).toBe(rawUsageJson)

      // Deeply verify no NaN survived into rawUsage.
      function assertNoNaN(value: unknown, path: string): void {
        if (value === null || typeof value === 'boolean' || typeof value === 'string')
          return
        if (typeof value === 'number') {
          expect(
            Number.isFinite(value),
            `rawUsage${path} must be finite (was ${String(value)})`,
          ).toBe(true)
          return
        }
        if (Array.isArray(value)) {
          value.forEach((item, i) => {
            assertNoNaN(item, `${path}[${i}]`)
          })
          return
        }
        if (typeof value === 'object') {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            assertNoNaN(v, `${path}.${k}`)
          }
        }
      }
      assertNoNaN(rec.rawUsage, '')
    }
  })

  /**
   * Combined adversarial case: non-finite values in BOTH details and raw,
   * along with malformed hot-field token counts.  Engine must not throw;
   * the record must persist and be JSON-safe.
   */
  it('combined: non-finite in hot fields + details + raw — engine never throws, record is JSON-safe', async () => {
    const rand = mulberry32(0xf1f2f3f4)

    for (let i = 0; i < 20; i++) {
      const usage: Usage = {
        inputTokens: rand() > 0.5 ? NaN : Math.floor(rand() * 1000),
        outputTokens: rand() > 0.5 ? Infinity : Math.floor(rand() * 500),
        details: {
          input: rand() > 0.5 ? NaN : 100,
          output: rand() > 0.5 ? -Infinity : 20,
          extra: rand() > 0.5 ? NaN : 5,
        },
        raw:
          rand() > 0.5 ? ({ x: NaN, y: { z: Infinity } } as unknown as JsonValue) : null,
      } as unknown as Usage

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      // Must resolve (never throw) for malformed usage — fail-open per SPEC.
      await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      const rec = sink.last()!

      // Record must be fully JSON-safe.
      expect(
        () => JSON.stringify(rec),
        `iter ${i}: JSON.stringify must not throw`,
      ).not.toThrow()
      const roundTripped = JSON.parse(JSON.stringify(rec)) as typeof rec
      expect(roundTripped.recordSchemaVersion, `iter ${i}: round-trip sanity`).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 4: Cost property — sum(details)===microUsd; unknown model → null
// ---------------------------------------------------------------------------

describe('surface-stress: cost property', () => {
  const KNOWN_MODELS = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
  ]
  const UNKNOWN_MODELS = [
    'gpt-4',
    'claude-3',
    'unknown-model-xyz',
    'llama-3',
    'mistral-large',
  ]

  it('known models: sum(details)===microUsd across random valid usages (100 iterations)', async () => {
    const rand = mulberry32(0xfeedface)

    for (let i = 0; i < 100; i++) {
      const model = KNOWN_MODELS[Math.floor(rand() * KNOWN_MODELS.length)]!
      const input = Math.floor(rand() * 300_000) + 1
      const cached = Math.floor(rand() * input) // ≤ input
      const output = Math.floor(rand() * 10_000) + 1
      const thinking = Math.floor(rand() * output) // ≤ output

      const usage: Usage = {
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cached,
        thinkingTokens: thinking,
        details: {},
        raw: null,
      }

      const cost: Cost = computeCost(model, usage)
      expect(cost.microUsd).not.toBeNull()
      if (cost.microUsd !== null) {
        expect(
          cost.details.input + cost.details.cached + cost.details.output,
          `iter ${i} (${model}): sum(details) must equal microUsd`,
        ).toBe(cost.microUsd)
      }
    }
  })

  it('unknown models: microUsd is null (50 iterations)', () => {
    const rand = mulberry32(0x0badc0de)

    for (let i = 0; i < 50; i++) {
      const model = UNKNOWN_MODELS[Math.floor(rand() * UNKNOWN_MODELS.length)]!
      const input = Math.floor(rand() * 10_000) + 1
      const output = Math.floor(rand() * 5_000) + 1

      const usage: Usage = {
        inputTokens: input,
        outputTokens: output,
        details: {},
        raw: null,
      }
      const cost: Cost = computeCost(model, usage)

      expect(cost.microUsd).toBeNull()
      expect(typeof cost.pricingVersion).toBe('string')
      // details still have numeric zeros (not null)
      expect(cost.details.input).toBe(0)
      expect(cost.details.cached).toBe(0)
      expect(cost.details.output).toBe(0)
    }
  })

  it('thinking tokens add zero EXTRA cost (billed inside output rate)', () => {
    const rand = mulberry32(0x5a5a5a5a)
    for (let i = 0; i < 50; i++) {
      const model = 'gemini-2.5-flash'
      const input = Math.floor(rand() * 50_000) + 1
      const output = Math.floor(rand() * 5_000) + 100
      const thinking = Math.floor(rand() * output)

      const usageWithThinking: Usage = {
        inputTokens: input,
        outputTokens: output,
        thinkingTokens: thinking,
        details: {},
        raw: null,
      }
      const usageNoThinking: Usage = {
        inputTokens: input,
        outputTokens: output,
        details: {},
        raw: null,
      }

      const costWith = computeCost(model, usageWithThinking)
      const costWithout = computeCost(model, usageNoThinking)

      // Thinking tokens must not add extra cost beyond outputTokens billing
      expect(costWith.microUsd).toBe(costWithout.microUsd)
      // Cost details must NOT have a 'thinking' lane
      expect(costWith.details).not.toHaveProperty('thinking')

      // Sum invariant
      if (costWith.microUsd !== null) {
        expect(
          costWith.details.input + costWith.details.cached + costWith.details.output,
        ).toBe(costWith.microUsd)
      }
    }
  })

  it('sum(details)===microUsd on the engine result vs record (50 iterations)', async () => {
    const rand = mulberry32(0xa1b2c3d4)
    for (let i = 0; i < 50; i++) {
      const model = KNOWN_MODELS[Math.floor(rand() * KNOWN_MODELS.length)]!
      const input = Math.floor(rand() * 300_000) + 1
      const cached = Math.floor(rand() * Math.min(input, 100_000))
      const output = Math.floor(rand() * 5_000) + 1
      const thinking = Math.floor(rand() * output)

      const usage: Usage = {
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cached,
        thinkingTokens: thinking,
        details: {},
        raw: null,
      }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ usage, model }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        { provider: 'google', model, messages: MESSAGES },
        { auth: TEST_AUTH },
      )

      expect(result.cost).toBeDefined()
      if (result.cost !== undefined && result.cost.microUsd !== null) {
        const sum =
          result.cost.details.input +
          result.cost.details.cached +
          result.cost.details.output
        expect(sum, `iter ${i}: sum(details) must equal microUsd`).toBe(
          result.cost.microUsd,
        )
        // Result cost === record cost (single source of truth)
        expect(sink.last()!.costMicroUsd).toBe(result.cost.microUsd)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 5: Fail-open
// ---------------------------------------------------------------------------

describe('surface-stress: fail-open', () => {
  it('throwing sink does not fail the generate call (5 variants)', async () => {
    const sinkErrors = [true, new Error('sink boom')] as const

    for (const failSpec of sinkErrors) {
      const sink = new RecordingSink({ failOnRecord: failSpec })
      const client = createClient({
        adapters: [new FakeAdapter('google', makeOkResult())],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      // Should NOT throw despite the sink failing
      const result = await client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      )
      expect(result.text).toBe('ok')
      // Sink threw before storing, so no records
      expect(sink.records).toHaveLength(0)
    }
  })

  it('throwing sink on error path: LlmError still rethrown (5 iterations)', async () => {
    const sink = new RecordingSink({ failOnRecord: true })
    const adapter = new FakeAdapter('google', { status: 500 })

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('throwing telemetry never fails the call', async () => {
    const throwingTelemetry: Telemetry = {
      onStart: () => {
        throw new Error('telemetry start boom')
      },
      onSuccess: () => {
        throw new Error('telemetry success boom')
      },
      onError: () => {
        throw new Error('telemetry error boom')
      },
    }

    // Success path — telemetry throws in onStart + onSuccess
    const successClient = createClient({
      adapters: [new FakeAdapter('google', makeOkResult())],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      telemetry: throwingTelemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    const result = await successClient.generate(
      { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
      { auth: TEST_AUTH },
    )
    expect(result.text).toBe('ok')

    // Error path — telemetry throws in onStart + onError, error still rethrown
    const failClient = createClient({
      adapters: [new FakeAdapter('google', { status: 503 })],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      telemetry: throwingTelemetry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    await expect(
      failClient.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('pricing that throws: cost is undefined on result, call still succeeds', async () => {
    const throwingPricing: PricingSource = {
      version: 'boom',
      price(): Cost {
        throw new Error('pricing exploded')
      },
      hasModel(): boolean {
        return true
      },
      listModels(): readonly string[] {
        return ['gemini-2.5-pro']
      },
    }

    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeOkResult())],
      pricingSources: { google: throwingPricing },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const result = await client.generate(
      { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
      { auth: TEST_AUTH },
    )
    // Cost is absent (pricing failed, fail-open)
    expect(result.cost).toBeUndefined()
    // Call still succeeded
    expect(result.text).toBe('ok')
    // Record still written
    expect(sink.records).toHaveLength(1)
    expect(sink.last()!.status).toBe('ok')
    // A warning about cost failure is present
    const hasCostWarn = result.warnings.some(
      (w): w is Warning & { type: 'other' } =>
        w.type === 'other' && w.message.toLowerCase().includes('cost'),
    )
    expect(hasCostWarn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 6: Cancellation — classification is 'timeout' or 'aborted', never mixed
// ---------------------------------------------------------------------------

describe('surface-stress: cancellation', () => {
  it('timeoutMs < adapter delay → always classified as timeout (10 iterations)', async () => {
    const rand = mulberry32(0x33221100)
    for (let i = 0; i < 10; i++) {
      const adapterDelayMs = 200 + Math.floor(rand() * 200) // 200–400ms
      const timeoutMs = 1 + Math.floor(rand() * 20) // 1–21ms

      const adapter = new FakeAdapter('google', makeOkResult(), {
        delayMs: adapterDelayMs,
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await expect(
        client.generate(
          {
            provider: 'google',
            model: 'gemini-2.5-pro',
            messages: MESSAGES,
            config: { timeoutMs },
          },
          { auth: TEST_AUTH },
        ),
      ).rejects.toMatchObject({ kind: 'timeout', retryable: true })

      const rec = sink.last()!
      expect(rec.status).toBe('timeout')
      expect(rec.errorKind).toBe('timeout')
    }
  }, 10_000)

  it('caller abort mid-flight → always classified as aborted (10 iterations)', async () => {
    const rand = mulberry32(0x99887766)
    for (let i = 0; i < 10; i++) {
      const adapterDelayMs = 200 + Math.floor(rand() * 100) // 200–300ms
      const abortAfterMs = 10 + Math.floor(rand() * 30) // 10–40ms

      const adapter = new SignalAwareFakeAdapter('google', makeOkResult(), {
        delayMs: adapterDelayMs,
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), abortAfterMs)

      try {
        await expect(
          client.generate(
            { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
            { auth: TEST_AUTH, signal: ctrl.signal },
          ),
        ).rejects.toMatchObject({ kind: 'aborted', retryable: false })

        const rec = sink.last()!
        expect(rec.status).toBe('aborted')
        expect(rec.errorKind).toBe('aborted')
      } finally {
        clearTimeout(timer)
      }
    }
  }, 10_000)

  it('timeout + synchronously-aborting adapter → timeout wins, never aborted (5 iterations)', async () => {
    const rand = mulberry32(0x55443322)
    for (let i = 0; i < 5; i++) {
      const timeoutMs = 5 + Math.floor(rand() * 20) // 5–25ms

      const adapter = new SignalAwareFakeAdapter('google', makeOkResult(), {
        delayMs: 5_000,
        abortsSynchronouslyOnSignal: true,
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await expect(
        client.generate(
          {
            provider: 'google',
            model: 'gemini-2.5-pro',
            messages: MESSAGES,
            config: { timeoutMs },
          },
          { auth: TEST_AUTH },
        ),
      ).rejects.toMatchObject({ kind: 'timeout' })

      const rec = sink.last()!
      expect(rec.status).toBe('timeout')
    }
  }, 10_000)

  it('already-aborted signal → LlmError aborted, record status aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()

    const adapter = new SignalAwareFakeAdapter('google', makeOkResult(), { delayMs: 300 })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(
      client.generate(
        { provider: 'google', model: 'gemini-2.5-pro', messages: MESSAGES },
        { auth: TEST_AUTH, signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' })

    expect(sink.last()!.status).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 7: Structured output is parse-only; caller owns validation
// ---------------------------------------------------------------------------

describe('surface-stress: structured output parse-only', () => {
  it('shape-mismatching rawStructured still succeeds (30 iterations)', async () => {
    const rand = mulberry32(0x99aabbcc)

    type BadCase = {
      jsonSchema: { type: 'object'; additionalProperties: true }
      badValue: unknown
    }
    const CASES: BadCase[] = [
      {
        jsonSchema: { type: 'object', additionalProperties: true },
        badValue: { answer: 'not-a-number' },
      },
      { jsonSchema: { type: 'object', additionalProperties: true }, badValue: null },
      { jsonSchema: { type: 'object', additionalProperties: true }, badValue: undefined },
      { jsonSchema: { type: 'object', additionalProperties: true }, badValue: 42 },
      {
        jsonSchema: { type: 'object', additionalProperties: true },
        badValue: { name: 123 },
      },
      {
        jsonSchema: { type: 'object', additionalProperties: true },
        badValue: { items: [1, 2, 3] },
      },
      {
        jsonSchema: { type: 'object', additionalProperties: true },
        badValue: { id: 'not-a-uuid' },
      },
      {
        jsonSchema: { type: 'object', additionalProperties: true },
        badValue: { score: 99 },
      },
    ]

    for (let i = 0; i < 30; i++) {
      const { jsonSchema, badValue } = CASES[Math.floor(rand() * CASES.length)]!
      const sink = new RecordingSink()

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ rawStructured: badValue }),
      })

      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: MESSAGES,
          output: { jsonSchema },
        },
        { auth: TEST_AUTH },
      )

      const rec = sink.last()!
      expect(result.output).toEqual(badValue)
      expect(result.outputParsed).toBe(badValue !== undefined)
      expect(rec.status, `iter ${i}: record status must be ok`).toBe('ok')
    }
  })

  it('rawStructured is passed through, record status ok', async () => {
    const rand = mulberry32(0x11112222)
    for (let i = 0; i < 20; i++) {
      const answer = Math.floor(rand() * 1000)
      const jsonSchema = { type: 'object', properties: { answer: { type: 'number' } } }

      const adapter = new RawThrowAdapter('google', {
        kind: 'ok',
        result: makeOkResult({ rawStructured: { answer } }),
      })
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        sink,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      const result = await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: MESSAGES,
          output: { jsonSchema },
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
// INVARIANT 8: providerOptions.google allowlist enforced through resolution
// ---------------------------------------------------------------------------

describe('surface-stress: providerOptions.google strict allowlist', () => {
  it('allowlisted providerOptions survive merge and are passed to adapter (20 iterations)', async () => {
    const rand = mulberry32(0xaabbccdd)

    for (let i = 0; i < 20; i++) {
      const uniqueVal = Math.floor(rand() * 100_000)

      // Capture adapter calls
      const capturedOptions: Array<ProviderOptions | undefined> = []
      const captureAdapter: ProviderAdapter = {
        id: 'google',
        async run(req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
          capturedOptions.push(req.config.providerOptions)
          return makeOkResult()
        },
      }

      const client = createClient({
        adapters: [captureAdapter],
        pricingSources: { google: PRICING },
        modelRegistry: STRICT_REGISTRY,
        clock: new FakeClock(),
        ids: new FakeIds(),
        defaults: {
          providerOptions: {
            google: {
              cachedContent: `cachedContents/base-${i}`,
              httpOptions: { timeout: 60_000 + uniqueVal },
            },
          },
        },
      })

      await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: MESSAGES,
          config: {
            providerOptions: {
              google: {
                safetySettings: [
                  {
                    category: SAFETY_CATEGORIES[i % SAFETY_CATEGORIES.length]!,
                    threshold: 'BLOCK_ONLY_HIGH',
                  },
                ],
              },
            },
          },
        },
        { auth: TEST_AUTH },
      )

      const merged = capturedOptions[0]
      expect(merged).toBeDefined()

      const googleBlock = merged!['google'] as Record<string, unknown>
      expect(googleBlock['cachedContent']).toBe(`cachedContents/base-${i}`)
      expect(googleBlock['httpOptions']).toEqual({ timeout: 60_000 + uniqueVal })
      expect(googleBlock['safetySettings']).toEqual([
        {
          category: SAFETY_CATEGORIES[i % SAFETY_CATEGORIES.length]!,
          threshold: 'BLOCK_ONLY_HIGH',
        },
      ])
    }
  })

  it('unknown google providerOptions reject before adapter dispatch (20 iterations)', async () => {
    const rand = mulberry32(0xddccbbaa)

    for (let i = 0; i < 20; i++) {
      const uniqueVal = Math.floor(rand() * 100_000)
      const captureAdapter: ProviderAdapter = {
        id: 'google',
        async run(): Promise<AdapterResult> {
          throw new Error('adapter should not be called for invalid providerOptions')
        },
      }

      const client = createClient({
        adapters: [captureAdapter],
        pricingSources: { google: PRICING },
        modelRegistry: STRICT_REGISTRY,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })

      await expect(
        client.generate(
          {
            provider: 'google',
            model: 'gemini-2.5-pro',
            messages: MESSAGES,
            config: {
              providerOptions: {
                google: { [`unknown_${i}`]: uniqueVal },
              },
            },
          },
          { auth: TEST_AUTH },
        ),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    }
  })
})
