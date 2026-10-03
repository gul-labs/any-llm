import { describe, expect, it, expectTypeOf } from 'vitest'

import * as surface from './index.js'
import type {
  TokenCountRequest,
  TokenCount,
  Citation,
  Client,
  LlmErrorIssue,
  LlmErrorOptions,
  LlmError,
  CallSite,
  StandardSchemaV1,
  LlmRequest,
  ClientConfig,
} from './index.js'

const removedConfigSchemaFactory = `makeGeminiConfig${'Schema'}`
const removedConfigValidatorFactory = `makeGeminiConfig${'Validator'}`
const removedReasoningHelper = `resolve${'Reasoning'}`
const removedEffortBudget = `EFFORT${'_BUDGET'}`
const removedGoogleProviderOptions = `Google${'ProviderOptions'}`
const removedGoogleSafetySetting = `Google${'SafetySetting'}`
const removedGoogleSearchTool = `Google${'SearchTool'}`

describe('@gullabs/core package surface', () => {
  it('keeps strict-schema helpers and omits deleted legacy exports', () => {
    expect(typeof surface.toConfigJsonSchema).toBe('function')
    expect(typeof surface.zodToStandardSchema).toBe('function')
    expect(removedConfigSchemaFactory in surface).toBe(false)
    expect(removedConfigValidatorFactory in surface).toBe(false)
    expect(removedReasoningHelper in surface).toBe(false)
    expect(removedEffortBudget in surface).toBe(false)
  })

  it('exports composeProviders for assembling ProviderPlugins', () => {
    expect(typeof surface.composeProviders).toBe('function')
  })

  it('exports canonicalJson (RFC 8785)', () => {
    expect(surface.canonicalJson({ b: 1, a: [true] })).toBe('{"a":[true],"b":1}')
  })

  it('no longer exports the Google-specific provider option types (moved to @gullabs/google)', () => {
    // These were only ever type exports, so this `in` check cannot catch a
    // stray `export type`; it only guards against someone reintroducing them
    // as runtime values. `packages/google/src/dist-augmentation.test.ts` is
    // the actual enforcement mechanism for the published-artifact contract
    // (it type-checks fixtures against the *built* `dist/index.d.ts` files).
    // `packages/google/src/provider-options.test.ts` is documentation-grade:
    // it demonstrates source-level type inference within the monorepo's
    // shared tsconfig program, but the root tsconfig compiles all
    // `packages/*/src` together, so a `declare module` augmentation is
    // globally in scope there regardless of which package's `index.ts`
    // actually imports the declaring module — it does not prove the
    // augmentation survives the package boundary.
    expect(removedGoogleProviderOptions in surface).toBe(false)
    expect(removedGoogleSafetySetting in surface).toBe(false)
    expect(removedGoogleSearchTool in surface).toBe(false)
  })

  it('exports TokenCountRequest/TokenCount types and Client.countTokens', () => {
    expectTypeOf<TokenCountRequest>().toEqualTypeOf<{
      provider: string
      model: string
      system?: string
      messages: import('./types.js').Message[]
      tools?: import('./types.js').ToolDefinition[]
    }>()
    expectTypeOf<TokenCount>().toEqualTypeOf<{
      totalTokens: number
      accuracy: 'exact' | 'lower-bound' | 'estimated'
      details?: Record<string, number>
      raw: import('./types.js').JsonValue
    }>()
    expectTypeOf<Client['countTokens']>().toEqualTypeOf<
      (
        request: TokenCountRequest,
        opts: import('./engine.js').GenerateOptions,
      ) => Promise<TokenCount>
    >()
  })

  it('exports LlmErrorIssue and LlmErrorOptions.issues (D6 input-contracts surface)', () => {
    expectTypeOf<LlmErrorIssue>().toEqualTypeOf<{ path: string; message: string }>()
    expectTypeOf<LlmErrorOptions>().toHaveProperty('issues')
    expectTypeOf<LlmErrorOptions['issues']>().toEqualTypeOf<
      readonly LlmErrorIssue[] | undefined
    >()
    expectTypeOf<LlmError['issues']>().toEqualTypeOf<
      readonly LlmErrorIssue[] | undefined
    >()
  })

  it('exports CallSite.inputSchema as an optional StandardSchemaV1 (D2 surface)', () => {
    expectTypeOf<CallSite>().toHaveProperty('inputSchema')
    expectTypeOf<CallSite['inputSchema']>().toEqualTypeOf<StandardSchemaV1 | undefined>()
  })

  it('exports LlmRequest.inputContract as an optional { schema, value } pair (D3 surface)', () => {
    expectTypeOf<LlmRequest>().toHaveProperty('inputContract')
    expectTypeOf<LlmRequest['inputContract']>().toEqualTypeOf<
      { schema: StandardSchemaV1; value: unknown } | undefined
    >()
  })

  it('exports Citation from the package surface', () => {
    expectTypeOf<Citation>().toEqualTypeOf<{
      url: string
      title?: string
      sourceName?: string
    }>()
  })

  it('exports ClientConfig.requireInputContract as an optional boolean (D4 surface)', () => {
    expectTypeOf<ClientConfig>().toHaveProperty('requireInputContract')
    expectTypeOf<ClientConfig['requireInputContract']>().toEqualTypeOf<
      boolean | undefined
    >()
  })
})
